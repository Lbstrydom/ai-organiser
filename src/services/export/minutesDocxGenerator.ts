/**
 * Minutes DOCX Generator
 *
 * Converts MinutesJSON to a professionally formatted Word (.docx) document.
 * Uses the `docx` library (already a project dependency).
 *
 * Design: Pure function (no Obsidian dependencies), lazy-loads `docx` library.
 * Sections: Title page → Metadata → Participants → Agenda → Decisions →
 *           Actions → Key Points → Risks → Open Questions → Deferred Items → GTD
 */

import type { MinutesJSON, GTDAction } from '../prompts/minutesPrompts';
import type { MinutesStyle } from '../../core/constants';
import { stripConfidenceAnnotations, groupPointsBySubTopic, hasAnyAgendaRef } from '../../utils/minutesUtils';

export interface MinutesDocxOptions {
    /** Include confidentiality banner when level is not 'public' */
    includeConfidentialityBanner?: boolean;
    /** Minutes style — controls section layout. Defaults to json.metadata.style or 'standard'. */
    style?: MinutesStyle;
}

export async function generateMinutesDocx(
    json: MinutesJSON,
    options: MinutesDocxOptions = {}
): Promise<ArrayBuffer> {
    const {
        Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
        WidthType, AlignmentType, Packer, ShadingType
    } = await import('docx');

    const meta = json.metadata;
    const style: MinutesStyle = options.style || meta?.style || 'standard';
    const title = meta?.title || 'Meeting Minutes';
    const children: any[] = [];

    // Belt-and-suspenders: deep-strip confidence annotations from all JSON text fields
    deepStripConfidence(json);

    // ── Confidentiality banner ─────────────────────────────────────────
    const showBanner = options.includeConfidentialityBanner !== false;
    if (showBanner && meta?.confidentiality_level && meta.confidentiality_level !== 'public') {
        const label = meta.confidentiality_level.replace(/_/g, ' ').toUpperCase();
        children.push(new Paragraph({
            children: [new TextRun({
                text: label,
                bold: true,
                size: 20,
                font: 'Calibri',
                color: 'FFFFFF',
            })],
            shading: { type: ShadingType.SOLID, color: 'CC0000', fill: 'CC0000' },
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
        }));
    }

    // ── Title ──────────────────────────────────────────────────────────
    children.push(new Paragraph({
        children: [new TextRun({ text: title, bold: true, size: 40, font: 'Calibri' })],
        heading: HeadingLevel.TITLE,
        spacing: { after: 120 },
    }));

    // ── Metadata table ────────────────────────────────────────────────
    const metaRows: [string, string][] = [];
    if (meta?.date) {
        let dateLine = meta.date;
        if (meta.start_time) {
            dateLine += `  ${meta.start_time}`;
            if (meta.end_time) dateLine += ` – ${meta.end_time}`;
            if (meta.timezone) dateLine += ` (${meta.timezone})`;
        }
        metaRows.push(['Date / Time', dateLine]);
    }
    if (meta?.location) metaRows.push(['Location', meta.location]);
    if (meta?.chair) metaRows.push(['Chair', meta.chair]);
    if (meta?.minute_taker) metaRows.push(['Minute Taker', meta.minute_taker]);
    if (meta?.meeting_context) metaRows.push(['Context', meta.meeting_context]);
    if (meta?.output_audience) metaRows.push(['Audience', meta.output_audience]);
    if (meta?.quorum_present !== null && meta?.quorum_present !== undefined) {
        metaRows.push(['Quorum', meta.quorum_present ? 'Yes' : 'No']);
    }

    if (metaRows.length > 0) {
        const rows = metaRows.map(([label, value]) => new TableRow({
            children: [
                new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: label, bold: true, size: 20, font: 'Calibri' })],
                    })],
                    width: { size: 25, type: WidthType.PERCENTAGE },
                    shading: { type: ShadingType.SOLID, color: 'F0F0F0', fill: 'F0F0F0' },
                }),
                new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: value, size: 20, font: 'Calibri' })],
                    })],
                    width: { size: 75, type: WidthType.PERCENTAGE },
                }),
            ],
        }));
        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(spacer(Paragraph));
    }

    // ── Participants ──────────────────────────────────────────────────
    const attendees = json.participants?.filter(p => p.attendance !== 'apologies') || [];
    const apologies = json.participants?.filter(p => p.attendance === 'apologies') || [];

    if (attendees.length > 0 || apologies.length > 0) {
        children.push(heading2('Participants', { Paragraph, TextRun, HeadingLevel }));

        if (attendees.length > 0) {
            const headerRow = tableHeaderRow(['Name', 'Role', 'Organisation'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
            const dataRows = attendees.map(p => tableDataRow(
                [p.name, p.role || '', p.organisation || ''],
                { TableRow, TableCell, Paragraph, TextRun }
            ));
            children.push(new Table({
                rows: [headerRow, ...dataRows],
                width: { size: 100, type: WidthType.PERCENTAGE },
            }));
        }

        if (apologies.length > 0) {
            children.push(new Paragraph({
                children: [
                    new TextRun({ text: 'Apologies: ', bold: true, size: 20, font: 'Calibri' }),
                    new TextRun({ text: apologies.map(p => p.name).join(', '), size: 20, font: 'Calibri' }),
                ],
                spacing: { before: 80, after: 80 },
            }));
        }
        children.push(spacer(Paragraph));
    }

    // ── Summary (standard/guided — brief overview, matches markdown) ──
    if (style !== 'smart-brevity' && style !== 'detailed' && json.notable_points?.length > 0) {
        children.push(heading2('Summary', { Paragraph, TextRun, HeadingLevel }));
        const summaryText = json.notable_points.slice(0, 2).map(p => p.text).join(' ');
        children.push(new Paragraph({
            children: [new TextRun({ text: summaryText, size: 20, font: 'Calibri' })],
            spacing: { after: 80 },
        }));
        children.push(spacer(Paragraph));
    }

    // ── Main content body (per-agenda-item or flat) ──────────────────
    const hasAgenda = json.agenda?.length > 0;
    const hasLinkedItems = hasAgenda && hasAnyAgendaRef(json);
    const docxTypes = { Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType };

    if (hasLinkedItems) {
        renderDocxAgendaGrouped(json, children, style, docxTypes);
    } else {
        // Flat layout fallback (when no agenda_item_ref links exist)
        if (hasAgenda) {
            children.push(heading2('Agenda', { Paragraph, TextRun, HeadingLevel }));
            json.agenda.forEach((item, i) => {
                children.push(new Paragraph({
                    children: [new TextRun({ text: `${i + 1}. ${item}`, size: 20, font: 'Calibri' })],
                    spacing: { after: 40 },
                }));
            });
            children.push(spacer(Paragraph));
        }

        if (json.decisions?.length > 0) {
            children.push(heading2('Decisions', { Paragraph, TextRun, HeadingLevel }));
            const headerRow = tableHeaderRow(['ID', 'Decision', 'Owner', 'Due'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
            const dataRows = json.decisions.map(d => tableDataRow(
                [d.id, d.text, d.owner || '—', d.due_date || '—'],
                { TableRow, TableCell, Paragraph, TextRun }
            ));
            children.push(new Table({
                rows: [headerRow, ...dataRows],
                width: { size: 100, type: WidthType.PERCENTAGE },
            }));
            children.push(spacer(Paragraph));
        }

        if (json.actions?.length > 0) {
            children.push(heading2('Actions', { Paragraph, TextRun, HeadingLevel }));
            const headerRow = tableHeaderRow(['ID', 'Action', 'Owner', 'Due'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
            const dataRows = json.actions.map(a => tableDataRow(
                [a.id, a.text, a.owner, a.due_date || '—'],
                { TableRow, TableCell, Paragraph, TextRun }
            ));
            children.push(new Table({
                rows: [headerRow, ...dataRows],
                width: { size: 100, type: WidthType.PERCENTAGE },
            }));
            children.push(spacer(Paragraph));
        }

        if (json.notable_points?.length > 0) {
            children.push(heading2('Key Points', { Paragraph, TextRun, HeadingLevel }));
            json.notable_points.forEach(p => {
                children.push(new Paragraph({
                    children: [new TextRun({ text: p.text, size: 20, font: 'Calibri' })],
                    bullet: { level: 0 },
                    spacing: { after: 40 },
                }));
            });
            children.push(spacer(Paragraph));
        }
    }

    // ── Risks / Opportunities ────────────────────────────────────────
    // smart-brevity: omit entirely; standard: "Opportunities and Obstacles" capped at 6;
    // detailed: included in Appendix below; guided: same as standard
    if (style !== 'smart-brevity' && style !== 'detailed' && json.risks?.length > 0) {
        const capped = json.risks.slice(0, 6);
        children.push(heading2('Opportunities and Obstacles', { Paragraph, TextRun, HeadingLevel }));
        capped.forEach(r => {
            children.push(new Paragraph({
                children: [new TextRun({ text: r.text, size: 20, font: 'Calibri' })],
                bullet: { level: 0 },
                spacing: { after: 40 },
            }));
        });
        children.push(spacer(Paragraph));
    }

    // ── Open Questions (standard/guided only — omit for smart-brevity, appendix for detailed) ──
    if (style === 'detailed') {
        // Deferred to Appendix below
    } else if (style !== 'smart-brevity' && json.open_questions?.length > 0) {
        children.push(heading2('Open Questions', { Paragraph, TextRun, HeadingLevel }));
        json.open_questions.forEach(q => {
            const parts = [new TextRun({ text: q.text, size: 20, font: 'Calibri' })];
            if (q.owner) parts.push(new TextRun({ text: ` (${q.owner})`, italics: true, size: 20, font: 'Calibri' }));
            children.push(new Paragraph({ children: parts, bullet: { level: 0 }, spacing: { after: 40 } }));
        });
        children.push(spacer(Paragraph));
    }

    // ── Deferred Items (standard/guided only — omit for smart-brevity, appendix for detailed) ──
    if (style === 'detailed') {
        // Deferred to Appendix below
    } else if (style !== 'smart-brevity' && json.deferred_items?.length > 0) {
        children.push(heading2('Deferred Items', { Paragraph, TextRun, HeadingLevel }));
        json.deferred_items.forEach(d => {
            const parts = [new TextRun({ text: d.text, size: 20, font: 'Calibri' })];
            if (d.reason) parts.push(new TextRun({ text: ` — ${d.reason}`, italics: true, size: 20, font: 'Calibri' }));
            children.push(new Paragraph({ children: parts, bullet: { level: 0 }, spacing: { after: 40 } }));
        });
        children.push(spacer(Paragraph));
    }

    // ── Appendix (detailed style only) ───────────────────────────────
    if (style === 'detailed') {
        const hasRisks = json.risks?.length > 0;
        const hasQuestions = json.open_questions?.length > 0;
        const hasDeferred = json.deferred_items?.length > 0;

        if (hasRisks || hasQuestions || hasDeferred) {
            children.push(heading2('Appendix', { Paragraph, TextRun, HeadingLevel }));

            if (hasRisks) {
                const capped = json.risks.slice(0, 6);
                children.push(new Paragraph({
                    children: [new TextRun({ text: 'Risks & Issues', bold: true, size: 22, font: 'Calibri' })],
                    spacing: { before: 120, after: 60 },
                }));
                capped.forEach(r => {
                    children.push(new Paragraph({
                        children: [new TextRun({ text: r.text, size: 20, font: 'Calibri' })],
                        bullet: { level: 0 },
                        spacing: { after: 40 },
                    }));
                });
            }

            if (hasDeferred) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: 'Deferred Items', bold: true, size: 22, font: 'Calibri' })],
                    spacing: { before: 120, after: 60 },
                }));
                json.deferred_items.forEach(d => {
                    const parts = [new TextRun({ text: d.text, size: 20, font: 'Calibri' })];
                    if (d.reason) parts.push(new TextRun({ text: ` — ${d.reason}`, italics: true, size: 20, font: 'Calibri' }));
                    children.push(new Paragraph({ children: parts, bullet: { level: 0 }, spacing: { after: 40 } }));
                });
            }

            if (hasQuestions) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: 'Open Questions', bold: true, size: 22, font: 'Calibri' })],
                    spacing: { before: 120, after: 60 },
                }));
                json.open_questions.forEach(q => {
                    const parts = [new TextRun({ text: q.text, size: 20, font: 'Calibri' })];
                    if (q.owner) parts.push(new TextRun({ text: ` (${q.owner})`, italics: true, size: 20, font: 'Calibri' }));
                    children.push(new Paragraph({ children: parts, bullet: { level: 0 }, spacing: { after: 40 } }));
                });
            }

            children.push(spacer(Paragraph));
        }
    }

    // ── GTD Processing ────────────────────────────────────────────────
    const gtd = json.gtd_processing;
    if (gtd) {
        if (gtd.next_actions?.length > 0) {
            children.push(heading2('GTD: Next Actions', { Paragraph, TextRun, HeadingLevel }));
            const byContext = new Map<string, GTDAction[]>();
            for (const a of gtd.next_actions) {
                const ctx = a.context || '@uncategorized';
                if (!byContext.has(ctx)) byContext.set(ctx, []);
                byContext.get(ctx)!.push(a);
            }
            const sortedKeys = [...byContext.keys()].sort((a, b) => a.localeCompare(b));
            for (const ctx of sortedKeys) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: ctx, bold: true, size: 20, font: 'Calibri' })],
                    spacing: { before: 80, after: 40 },
                }));
                for (const a of byContext.get(ctx)!) {
                    let text = a.text;
                    if (a.owner) text += ` (${a.owner})`;
                    if (a.energy && a.energy !== 'medium') text += ` [${a.energy}]`;
                    children.push(new Paragraph({
                        children: [new TextRun({ text, size: 20, font: 'Calibri' })],
                        bullet: { level: 0 },
                        spacing: { after: 30 },
                    }));
                }
            }
            children.push(spacer(Paragraph));
        }
        if (gtd.waiting_for?.length > 0) {
            children.push(heading2('GTD: Waiting For', { Paragraph, TextRun, HeadingLevel }));
            gtd.waiting_for.forEach(w => {
                let text = `${w.text} — waiting on: ${w.waiting_on}`;
                if (w.chase_date) text += ` (chase: ${w.chase_date})`;
                children.push(new Paragraph({
                    children: [new TextRun({ text, size: 20, font: 'Calibri' })],
                    bullet: { level: 0 },
                    spacing: { after: 40 },
                }));
            });
            children.push(spacer(Paragraph));
        }
        if (gtd.projects?.length > 0) {
            children.push(heading2('GTD: Projects', { Paragraph, TextRun, HeadingLevel }));
            gtd.projects.forEach(p => {
                children.push(new Paragraph({
                    children: [new TextRun({ text: p, size: 20, font: 'Calibri' })],
                    bullet: { level: 0 },
                    spacing: { after: 40 },
                }));
            });
            children.push(spacer(Paragraph));
        }
        if (gtd.someday_maybe?.length > 0) {
            children.push(heading2('GTD: Someday / Maybe', { Paragraph, TextRun, HeadingLevel }));
            gtd.someday_maybe.forEach(s => {
                children.push(new Paragraph({
                    children: [new TextRun({ text: s, size: 20, font: 'Calibri' })],
                    bullet: { level: 0 },
                    spacing: { after: 40 },
                }));
            });
        }
    }

    // ── Build document ────────────────────────────────────────────────
    const doc = new Document({
        sections: [{
            properties: {},
            children,
        }],
    });

    const buffer = await Packer.toBuffer(doc);
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return ab as ArrayBuffer;
}

// ── Per-agenda-item renderer (matches markdown renderStandardAgendaGrouped) ──

function renderDocxAgendaGrouped(
    json: MinutesJSON,
    children: any[],
    style: MinutesStyle,
    docx: any
): void {
    const { Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType } = docx;
    const agenda = json.agenda || [];
    const renderedPointIds = new Set<string>();
    const renderedDecisionIds = new Set<string>();
    const renderedActionIds = new Set<string>();

    for (let i = 0; i < agenda.length; i++) {
        const ref = i + 1;
        const title = agenda[i];
        const points = (json.notable_points || []).filter(p => p.agenda_item_ref === ref);
        const decisions = (json.decisions || []).filter(d => d.agenda_item_ref === ref);
        const actions = (json.actions || []).filter(a => a.agenda_item_ref === ref);

        // Agenda item heading
        children.push(heading2(`${ref}. ${title}`, { Paragraph, TextRun, HeadingLevel }));

        if (points.length === 0 && decisions.length === 0 && actions.length === 0) {
            children.push(new Paragraph({
                children: [new TextRun({
                    text: '[Transcript incomplete] This agenda item was not captured in the available transcript.',
                    italics: true, size: 20, font: 'Calibri',
                })],
                spacing: { after: 80 },
            }));
            children.push(spacer(Paragraph));
            continue;
        }

        // Discussion points (notable_points)
        if (points.length > 0) {
            if (style === 'detailed') {
                // Governance voice: prose paragraphs (no bullets)
                for (const p of points) {
                    children.push(new Paragraph({
                        children: [new TextRun({ text: p.text, size: 20, font: 'Calibri' })],
                        spacing: { after: 60 },
                    }));
                }
            } else {
                // Standard/guided: bullet points with optional sub-topic grouping
                const grouped = groupPointsBySubTopic(points);
                if (grouped.length === 1 || points.length <= 3) {
                    for (const p of points) {
                        children.push(new Paragraph({
                            children: [new TextRun({ text: p.text, size: 20, font: 'Calibri' })],
                            bullet: { level: 0 },
                            spacing: { after: 40 },
                        }));
                    }
                } else {
                    // Sub-topic grouping (Financial / Operations / General)
                    for (const group of grouped) {
                        children.push(new Paragraph({
                            children: [new TextRun({ text: group.label, bold: true, size: 22, font: 'Calibri' })],
                            spacing: { before: 80, after: 40 },
                        }));
                        for (const p of group.points) {
                            children.push(new Paragraph({
                                children: [new TextRun({ text: p.text, size: 20, font: 'Calibri' })],
                                bullet: { level: 0 },
                                spacing: { after: 40 },
                            }));
                        }
                    }
                }
            }
            points.forEach(p => renderedPointIds.add(p.id));
        }

        // Decisions table
        if (decisions.length > 0) {
            children.push(boldLabel('Decisions', { Paragraph, TextRun }));
            if (style === 'detailed') {
                // Detailed: ID | Decision | Owner (no Due column)
                const hRow = tableHeaderRow(['ID', 'Decision', 'Owner'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
                const dRows = decisions.map(d => tableDataRow(
                    [d.id, d.text, d.owner || '—'],
                    { TableRow, TableCell, Paragraph, TextRun }
                ));
                children.push(new Table({ rows: [hRow, ...dRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
            } else {
                // Standard: ID | Decision | Owner | Due
                const hRow = tableHeaderRow(['ID', 'Decision', 'Owner', 'Due'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
                const dRows = decisions.map(d => tableDataRow(
                    [d.id, d.text, d.owner || '—', d.due_date || '—'],
                    { TableRow, TableCell, Paragraph, TextRun }
                ));
                children.push(new Table({ rows: [hRow, ...dRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
            }
            decisions.forEach(d => renderedDecisionIds.add(d.id));
        }

        // Actions table
        if (actions.length > 0) {
            children.push(boldLabel('Actions', { Paragraph, TextRun }));
            const hRow = tableHeaderRow(['ID', 'Action', 'Owner', 'Due'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
            const dRows = actions.map(a => tableDataRow(
                [a.id, a.text, a.owner, a.due_date || '—'],
                { TableRow, TableCell, Paragraph, TextRun }
            ));
            children.push(new Table({ rows: [hRow, ...dRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
            actions.forEach(a => renderedActionIds.add(a.id));
        }

        children.push(spacer(Paragraph));
    }

    // General Items — unlinked items (no agenda_item_ref)
    const unlinkedPoints = (json.notable_points || []).filter(p => !renderedPointIds.has(p.id));
    const unlinkedDecisions = (json.decisions || []).filter(d => !renderedDecisionIds.has(d.id));
    const unlinkedActions = (json.actions || []).filter(a => !renderedActionIds.has(a.id));

    if (unlinkedPoints.length > 0 || unlinkedDecisions.length > 0 || unlinkedActions.length > 0) {
        children.push(heading2('General Items', { Paragraph, TextRun, HeadingLevel }));

        if (unlinkedPoints.length > 0) {
            for (const p of unlinkedPoints) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: p.text, size: 20, font: 'Calibri' })],
                    bullet: { level: 0 },
                    spacing: { after: 40 },
                }));
            }
        }

        if (unlinkedDecisions.length > 0) {
            children.push(boldLabel('Decisions', { Paragraph, TextRun }));
            const hRow = tableHeaderRow(['ID', 'Decision', 'Owner', 'Due'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
            const dRows = unlinkedDecisions.map(d => tableDataRow(
                [d.id, d.text, d.owner || '—', d.due_date || '—'],
                { TableRow, TableCell, Paragraph, TextRun }
            ));
            children.push(new Table({ rows: [hRow, ...dRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
        }

        if (unlinkedActions.length > 0) {
            children.push(boldLabel('Actions', { Paragraph, TextRun }));
            const hRow = tableHeaderRow(['ID', 'Action', 'Owner', 'Due'], { TableRow, TableCell, Paragraph, TextRun, ShadingType });
            const dRows = unlinkedActions.map(a => tableDataRow(
                [a.id, a.text, a.owner, a.due_date || '—'],
                { TableRow, TableCell, Paragraph, TextRun }
            ));
            children.push(new Table({ rows: [hRow, ...dRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
        }

        children.push(spacer(Paragraph));
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract embedded MinutesJSON from a note's HTML comment.
 * Returns null if the note doesn't contain the AIO_MINUTES_JSON marker.
 */
export function extractMinutesJsonFromNote(content: string): MinutesJSON | null {
    const marker = '<!-- AIO_MINUTES_JSON:';
    const startIdx = content.indexOf(marker);
    if (startIdx === -1) return null;

    const jsonStart = startIdx + marker.length;
    const endIdx = content.indexOf(' -->', jsonStart);
    if (endIdx === -1) return null;

    try {
        return JSON.parse(content.substring(jsonStart, endIdx)) as MinutesJSON;
    } catch {
        return null;
    }
}

function spacer(Paragraph: any): any {
    return new Paragraph({ children: [], spacing: { after: 100 } });
}

function heading2(text: string, docx: any): any {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    return new Paragraph({
        children: [new TextRun({ text, bold: true, size: 26, font: 'Calibri' })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 80 },
    });
}

function boldLabel(text: string, docx: any): any {
    const { Paragraph, TextRun } = docx;
    return new Paragraph({
        children: [new TextRun({ text, bold: true, size: 22, font: 'Calibri' })],
        spacing: { before: 120, after: 60 },
    });
}

function tableHeaderRow(headers: string[], docx: any): any {
    const { TableRow, TableCell, Paragraph, TextRun, ShadingType } = docx;
    return new TableRow({
        tableHeader: true,
        children: headers.map(h => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: h, bold: true, size: 18, font: 'Calibri' })],
            })],
            shading: { type: ShadingType.SOLID, color: 'D9E2F3', fill: 'D9E2F3' },
        })),
    });
}

function tableDataRow(cells: string[], docx: any): any {
    const { TableRow, TableCell, Paragraph, TextRun } = docx;
    return new TableRow({
        children: cells.map(c => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: c, size: 18, font: 'Calibri' })],
            })],
        })),
    });
}

/** Recursively strip confidence annotations from all string values in a JSON object. */
function deepStripConfidence(obj: any): void {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string') {
            obj[key] = stripConfidenceAnnotations(obj[key]);
        } else if (Array.isArray(obj[key])) {
            for (let i = 0; i < obj[key].length; i++) {
                if (typeof obj[key][i] === 'string') {
                    obj[key][i] = stripConfidenceAnnotations(obj[key][i]);
                } else if (typeof obj[key][i] === 'object') {
                    deepStripConfidence(obj[key][i]);
                }
            }
        } else if (typeof obj[key] === 'object') {
            deepStripConfidence(obj[key]);
        }
    }
}
