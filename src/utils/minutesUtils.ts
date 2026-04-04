import { normalizePath, TAbstractFile, TFile, Vault } from 'obsidian';
import { Action, GTDAction, MinutesJSON } from '../services/prompts/minutesPrompts';
import { MinutesStyle } from '../core/constants';

/**
 * Strip confidence annotations from markdown text.
 * Removes patterns like *(low confidence)*, *(medium)*, etc.
 * Called on all markdown (both LLM-generated and rendered) before output.
 * Confidence data is preserved in the JSON comment for auditing.
 */
export function stripConfidenceAnnotations(text: string): string {
    return text
        .replace(/\s*\*\((?:low|medium|high)\s*confidence\)\*/gi, '')
        .replace(/\s*\*\((?:low|medium|high)\)\*/gi, '')
        .trim();
}

/**
 * Check if text looks like usable markdown rather than JSON fragments or garbage.
 * Must be >200 chars, contain at least one markdown heading, and not start with JSON.
 * Used by the guided renderer for LLM markdown passthrough validation.
 */
export function isUsableMarkdown(markdown: string): boolean {
    if (markdown.length <= 200) return false;
    if (markdown.startsWith('{') || markdown.startsWith('[')) return false;
    if (!/^#{1,6}\s/m.test(markdown)) return false;
    return true;
}

export interface MinutesFrontmatterInput {
    json: MinutesJSON;
    fallbackTitle: string;
    fallbackDate: string;
    /** Path to transcript file — rendered as wikilink for persistent linking */
    transcriptPath?: string;
}

export function sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '-').trim();
}

export async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const parts = normalized.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const existing = vault.getAbstractFileByPath(current);
        if (!existing) {
            try {
                await vault.createFolder(current);
            } catch (e) {
                // Race condition: folder may have been created between the check
                // and the createFolder call (e.g. concurrent saveTranscriptToDisk
                // + handleSubmit). Ignore "Folder already exists" errors.
                if (e instanceof Error && !/already exists/i.test(e.message)) {
                    throw e;
                }
            }
        }
    }
}

export async function getAvailableFilePath(
    vault: Vault,
    folderPath: string,
    fileName: string
) : Promise<string> {
    const normalizedFolder = normalizePath(folderPath);
    const basePath = normalizedFolder ? `${normalizedFolder}/${fileName}` : fileName;
    const existing = vault.getAbstractFileByPath(basePath);
    if (!existing) return basePath;

    const extensionIndex = fileName.lastIndexOf('.');
    const baseName = extensionIndex > -1 ? fileName.substring(0, extensionIndex) : fileName;
    const extension = extensionIndex > -1 ? fileName.substring(extensionIndex) : '';

    let counter = 2;
    let candidate = '';
    while (true) {
        candidate = normalizedFolder
            ? `${normalizedFolder}/${baseName} (${counter})${extension}`
            : `${baseName} (${counter})${extension}`;
        if (!vault.getAbstractFileByPath(candidate)) {
            return candidate;
        }
        counter++;
    }
}

export function buildMinutesFrontmatter(input: MinutesFrontmatterInput): string {
    const { json, fallbackTitle, fallbackDate } = input;
    const title = json.metadata?.title || fallbackTitle;
    const date = json.metadata?.date || fallbackDate;

    const attendees = json.participants?.filter(p => p.attendance !== 'apologies').map(p => p.name) || [];
    const apologies = json.participants?.filter(p => p.attendance === 'apologies').map(p => p.name) || [];

    const hasTbc = json.actions?.some(a => a.owner === 'TBC' || a.due_date === 'TBC') ||
        (json.open_questions?.length ?? 0) > 0;

    const lines: string[] = [];
    lines.push(`type: meeting`);
    lines.push(`meeting_title: ${yamlEscape(title)}`);
    lines.push(`meeting_date: ${yamlEscape(date)}`);
    lines.push(`meeting_start_time: ${yamlEscape(json.metadata?.start_time || '')}`);
    lines.push(`meeting_end_time: ${yamlEscape(json.metadata?.end_time || '')}`);
    lines.push(`meeting_timezone: ${yamlEscape(json.metadata?.timezone || '')}`);
    lines.push(`context: ${yamlEscape(json.metadata?.meeting_context || '')}`);
    lines.push(`output_audience: ${yamlEscape(json.metadata?.output_audience || '')}`);
    lines.push(`confidentiality: ${yamlEscape(json.metadata?.confidentiality_level || '')}`);
    lines.push(`chair: ${yamlEscape(json.metadata?.chair || '')}`);
    lines.push(`location: ${yamlEscape(json.metadata?.location || '')}`);
    lines.push(`actions_count: ${json.actions?.length ?? 0}`);
    lines.push(`decisions_count: ${json.decisions?.length ?? 0}`);
    lines.push(`has_tbc: ${hasTbc ? 'true' : 'false'}`);
    lines.push(`quorum: ${json.metadata?.quorum_present ?? 'null'}`);

    if (input.transcriptPath) {
        // Extract just the filename (without extension) for a clean wikilink
        const transcriptName = input.transcriptPath
            .replace(/\.md$/, '')
            .split('/').pop() || input.transcriptPath;
        lines.push(`transcript: "[[${transcriptName}]]"`);
    }

    if (attendees.length > 0) {
        lines.push(`attendees:`);
        attendees.forEach(a => lines.push(`  - ${yamlEscape(a)}`));
    }

    if (apologies.length > 0) {
        lines.push(`apologies:`);
        apologies.forEach(a => lines.push(`  - ${yamlEscape(a)}`));
    }

    return lines.join('\n') + '\n';
}

export function formatMinutesCallout(
    type: 'info' | 'danger',
    title: string,
    content: string
): string {
    const safeContent = content.trim();
    const lines = safeContent ? safeContent.split('\n') : ['(No content)'];
    const formattedLines = lines.map(line => `> ${line}`.trimEnd());
    return [`> [!${type}] ${title}`, ...formattedLines].join('\n');
}

export function formatActionsAsObsidianTasks(actions: Action[]): string {
    return actions.map(action => {
        const owner = action.owner && action.owner !== 'TBC' ? ` (${action.owner})` : '';
        const due = action.due_date && action.due_date !== 'TBC' ? `  [due:: ${action.due_date}]` : '';
        return `- [ ] ${action.text}${owner}${due}`;
    }).join('\n');
}

export function buildMinutesMarkdown(
    markdownInternal: string,
    markdownExternal: string | null,
    options: {
        includeTasks: boolean;
        actions: Action[];
    }
): string {
    let internalContent = markdownInternal.trim();
    if (options.includeTasks && options.actions.length > 0) {
        const tasksBlock = formatActionsAsObsidianTasks(options.actions);
        internalContent += `\n\n## Tasks\n\n${tasksBlock}`;
    }

    if (markdownExternal) {
        const externalCallout = formatMinutesCallout('info', 'External / Client Safe Minutes', markdownExternal);
        const internalCallout = formatMinutesCallout('danger', 'Internal / Private Notes', internalContent);
        return `${externalCallout}\n\n${internalCallout}`.trim();
    }

    return internalContent;
}

// ─── Sub-topic grouping for agenda items ───────────────────────

export interface PointGroup {
    label: string;
    points: Array<{ id: string; text: string; agenda_item_ref?: number | null }>;
}

const FINANCIAL_KEYWORDS = /\b(budget|ebitda|cash\s*flow|revenue|cost|costs|vat|tax|financial|finance|funding|capex|opex|margin|profit|loss|invoice|payment|debt|equity|dividend|write-off|impairment)\b/i;
const OPERATIONAL_KEYWORDS = /\b(safety|operational|operations|production|staffing|maintenance|hse|incident|outage|commissioning|construction|equipment|plant|facility|logistics|supply\s*chain|procurement)\b/i;

/**
 * Group notable_points by detected sub-topic (financial vs operational vs general).
 * Returns groups only when there's a meaningful split; otherwise returns a single group.
 */
export function groupPointsBySubTopic(points: Array<{ id: string; text: string; agenda_item_ref?: number | null }>): PointGroup[] {
    const financial: typeof points = [];
    const operational: typeof points = [];
    const general: typeof points = [];

    for (const p of points) {
        const isFin = FINANCIAL_KEYWORDS.test(p.text);
        const isOps = OPERATIONAL_KEYWORDS.test(p.text);
        if (isFin && !isOps) financial.push(p);
        else if (isOps && !isFin) operational.push(p);
        else general.push(p);
    }

    const groups: PointGroup[] = [];
    if (financial.length > 0) groups.push({ label: 'Financial', points: financial });
    if (operational.length > 0) groups.push({ label: 'Operations', points: operational });
    if (general.length > 0) groups.push({ label: 'General', points: general });

    // Only return multiple groups if there's a real split
    if (groups.length <= 1) return [{ label: 'General', points }];
    return groups;
}

// ─── Empty agenda item warning text (Phase 3 TRA) ───
const TRANSCRIPT_INCOMPLETE_AGENDA = '**[Transcript incomplete]** This agenda item was not captured in the available transcript. Content to be completed manually from attendees\' notes.';

/**
 * Render readable markdown minutes from structured JSON.
 * Dispatches to 4 style-specific renderers (Phase 3 TRA).
 * Used as primary rendering when LLM produces JSON-only output,
 * and as fallback when LLM markdown is empty/truncated.
 *
 * @param llmMarkdown - Only used by guided renderer for passthrough validation
 */
export function renderMinutesFromJson(
    json: MinutesJSON,
    style: MinutesStyle,
    obsidianTasksFormat?: boolean,
    llmMarkdown?: string
): string {
    let content: string;
    switch (style) {
        case 'smart-brevity':
            content = renderSmartBrevity(json);
            break;
        case 'standard':
            content = renderStandard(json, obsidianTasksFormat);
            break;
        case 'detailed':
            content = renderDetailed(json, obsidianTasksFormat);
            break;
        case 'guided':
            content = renderGuided(json, obsidianTasksFormat, llmMarkdown);
            break;
        default:
            content = renderStandard(json, obsidianTasksFormat);
    }

    // Append GTD if present (shared across all styles)
    if (json.gtd_processing) {
        content += '\n\n' + renderGTDSection(json.gtd_processing, obsidianTasksFormat);
    }

    // Belt-and-suspenders: strip any confidence annotations that leaked through JSON text fields
    return stripConfidenceAnnotations(content);
}

// ─── Shared helpers ──────────────────────────────────────────────

function formatParticipant(p: { name: string; role?: string; organisation?: string }): string {
    const extras = [p.role, p.organisation].filter(Boolean);
    return extras.length > 0 ? `${p.name} (${extras.join(', ')})` : p.name;
}

function renderHeaderBlock(json: MinutesJSON, includeQuorum: boolean): string[] {
    const sections: string[] = [];
    const meta = json.metadata;

    sections.push(`# ${meta?.title || 'Meeting Minutes'}`);

    const metaLines: string[] = [];
    if (meta?.date) {
        let dateLine = `**Date:** ${meta.date}`;
        if (meta.start_time) {
            dateLine += ` | **Time:** ${meta.start_time}`;
            if (meta.end_time) dateLine += `–${meta.end_time}`;
            if (meta.timezone) dateLine += ` (${meta.timezone})`;
        }
        metaLines.push(dateLine);
    }
    if (meta?.location) metaLines.push(`**Location:** ${meta.location}`);
    if (meta?.chair) metaLines.push(`**Chair:** ${meta.chair}`);
    if (meta?.minute_taker) metaLines.push(`**Minute taker:** ${meta.minute_taker}`);

    if (meta?.confidentiality_level && meta.confidentiality_level !== 'public') {
        metaLines.push(`**Confidentiality:** ${meta.confidentiality_level}`);
    }
    if (includeQuorum && meta?.quorum_present !== null && meta?.quorum_present !== undefined) {
        metaLines.push(`**Quorum:** ${meta.quorum_present ? 'Yes' : 'No'}`);
    }

    if (metaLines.length > 0) sections.push(metaLines.join('\n'));

    // Participants
    const attendees = json.participants?.filter(p => p.attendance !== 'apologies') || [];
    const apologies = json.participants?.filter(p => p.attendance === 'apologies') || [];

    if (attendees.length > 0) {
        sections.push(`**Attendees:** ${attendees.map(formatParticipant).join(', ')}`);
    }
    if (apologies.length > 0) {
        sections.push(`**Apologies:** ${apologies.map(p => p.name).join(', ')}`);
    }

    return sections;
}

function renderRisksAsOpportunities(json: MinutesJSON, maxItems: number): string | null {
    const risks = json.risks?.slice(0, maxItems) || [];
    if (risks.length === 0) return null;
    const lines = risks.map(r => `- ${r.text}`);
    return `## Opportunities and obstacles\n\n${lines.join('\n')}`;
}

function renderAppendix(json: MinutesJSON): string | null {
    const parts: string[] = [];

    const risks = json.risks?.slice(0, 6) || [];
    if (risks.length > 0) {
        const riskLines = risks.map(r => {
            let line = `- **${r.id}:** ${r.text}`;
            if (r.impact) line += ` — Impact: ${r.impact}`;
            if (r.mitigation) line += ` — Mitigation: ${r.mitigation}`;
            if (r.owner) line += ` (${r.owner})`;
            return line;
        });
        parts.push(`### Risks & Issues\n\n${riskLines.join('\n')}`);
    }

    if (json.deferred_items?.length > 0) {
        const dLines = json.deferred_items.map(d => {
            let line = `- **${d.id}:** ${d.text}`;
            if (d.reason) line += ` — Reason: ${d.reason}`;
            return line;
        });
        parts.push(`### Deferred Items\n\n${dLines.join('\n')}`);
    }

    if (json.open_questions?.length > 0) {
        const qLines = json.open_questions.map(q => {
            let line = `- **${q.id}:** ${q.text}`;
            if (q.owner) line += ` (${q.owner})`;
            return line;
        });
        parts.push(`### Follow-up Items\n\n${qLines.join('\n')}`);
    }

    if (parts.length === 0) return null;
    return `## Appendix\n\n${parts.join('\n\n')}`;
}

function renderGTDSection(gtd: import('../services/prompts/minutesPrompts').GTDProcessing, obsidianTasksFormat?: boolean): string {
    const sections: string[] = [];

    if (gtd.next_actions?.length > 0) {
        const byContext = new Map<string, GTDAction[]>();
        for (const a of gtd.next_actions) {
            const ctx = a.context || '@uncategorized';
            if (!byContext.has(ctx)) byContext.set(ctx, []);
            byContext.get(ctx)!.push(a);
        }
        const sortedKeys = [...byContext.keys()].sort((a, b) => a.localeCompare(b));
        const actionLines: string[] = [];
        for (const ctx of sortedKeys) {
            actionLines.push(`**${ctx}**`);
            for (const a of byContext.get(ctx)!) {
                const bullet = obsidianTasksFormat ? '- [ ] ' : '- ';
                let line = `${bullet}${a.text}`;
                if (a.owner) line += ` (${a.owner})`;
                if (a.energy && a.energy !== 'medium') line += ` [${a.energy}]`;
                actionLines.push(line);
            }
        }
        sections.push(`## GTD: Next Actions\n\n${actionLines.join('\n')}`);
    }
    if (gtd.waiting_for?.length > 0) {
        const wLines = gtd.waiting_for.map(w => {
            let line = `- ${w.text} — waiting on: ${w.waiting_on}`;
            if (w.chase_date) line += ` (chase: ${w.chase_date})`;
            return line;
        });
        sections.push(`## GTD: Waiting For\n\n${wLines.join('\n')}`);
    }
    if (gtd.projects?.length > 0) {
        sections.push(`## GTD: Projects\n\n${gtd.projects.map(p => `- ${p}`).join('\n')}`);
    }
    if (gtd.someday_maybe?.length > 0) {
        sections.push(`## GTD: Someday / Maybe\n\n${gtd.someday_maybe.map(s => `- ${s}`).join('\n')}`);
    }

    return sections.join('\n\n');
}

export function hasAnyAgendaRef(json: MinutesJSON): boolean {
    const check = (items: Array<{ agenda_item_ref?: number | null }> | undefined) =>
        items?.some(i => i.agenda_item_ref != null) || false;
    return check(json.notable_points) || check(json.decisions) || check(json.actions);
}

// ─── Smart Brevity renderer ─────────────────────────────────────

function renderSmartBrevity(json: MinutesJSON): string {
    const sections: string[] = [];

    // The big thing — first decision or most significant notable point
    const bigThing = json.decisions?.[0]?.text || json.notable_points?.[0]?.text || 'No key outcomes recorded.';
    sections.push(`## The big thing\n\n${bigThing}`);

    // Why it matters — from summary or first few notable points
    const whyParts: string[] = [];
    if (json.notable_points?.length > 0) {
        whyParts.push(...json.notable_points.slice(0, 3).map(p => p.text));
    }
    sections.push(`## Why it matters\n\n${whyParts.length > 0 ? whyParts.join(' ') : 'Context not available.'}`);

    // Decisions — numbered list
    if (json.decisions?.length > 0) {
        const lines = json.decisions.map((d, i) => `${i + 1}. ${d.text}`);
        sections.push(`## Decisions\n\n${lines.join('\n')}`);
    }

    // Actions — numbered list: Action — Owner — Due
    if (json.actions?.length > 0) {
        const lines = json.actions.map((a, i) => {
            const owner = a.owner || 'TBC';
            const due = a.due_date || 'TBC';
            return `${i + 1}. ${a.text} — ${owner} — ${due}`;
        });
        sections.push(`## Actions\n\n${lines.join('\n')}`);
    }

    // Go deeper — paragraphs with bold topic labels
    if (json.notable_points?.length > 0) {
        const paragraphs = json.notable_points.map(p => `**${p.id}** ${p.text}`);
        sections.push(`## Go deeper\n\n${paragraphs.join('\n\n')}`);
    }

    return sections.join('\n\n');
}

// ─── Standard renderer ──────────────────────────────────────────

function renderStandard(json: MinutesJSON, obsidianTasksFormat?: boolean): string {
    const sections = renderHeaderBlock(json, false);

    // Summary — 1-2 sentences max
    if (json.notable_points?.length > 0) {
        const summary = json.notable_points.slice(0, 2).map(p => p.text).join(' ');
        sections.push(`## Summary\n\n${summary}`);
    }

    // Per-agenda-item content
    const hasAgenda = json.agenda?.length > 0;
    const hasLinkedItems = hasAgenda && hasAnyAgendaRef(json);

    if (hasLinkedItems) {
        renderStandardAgendaGrouped(json, sections, obsidianTasksFormat);
    } else {
        // Flat layout
        if (hasAgenda) {
            const agendaLines = json.agenda.map((item, i) => `${i + 1}. ${item}`);
            sections.push(`## Agenda\n\n${agendaLines.join('\n')}`);
        }

        if (json.decisions?.length > 0) {
            const rows = json.decisions.map(d => {
                const owner = d.owner || '—';
                const due = d.due_date || '—';
                return `| ${d.id} | ${d.text} | ${owner} | ${due} |`;
            });
            sections.push(`## Decisions\n\n| ID | Decision | Owner | Due |\n|----|----------|-------|-----|\n${rows.join('\n')}`);
        }

        if (json.actions?.length > 0) {
            const rows = json.actions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            sections.push(`## Actions\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
        }
    }

    // Opportunities and obstacles (max 6, no separate Risks/Questions/Deferred)
    const opps = renderRisksAsOpportunities(json, 6);
    if (opps) sections.push(opps);

    // Next meeting
    const nextMeeting = json.notable_points?.find(p => /next\s+meeting/i.test(p.text));
    if (nextMeeting) {
        sections.push(`## Next meeting\n\n${nextMeeting.text}`);
    }

    return sections.join('\n\n');
}

function renderStandardAgendaGrouped(json: MinutesJSON, sections: string[], _obsidianTasksFormat?: boolean): void {
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

        const parts: string[] = [`## ${ref}. ${title}`];

        if (points.length === 0 && decisions.length === 0 && actions.length === 0) {
            parts.push(TRANSCRIPT_INCOMPLETE_AGENDA);
            sections.push(parts.join('\n\n'));
            continue;
        }

        // Narrative from discussion points — group by sub-topic if detectable
        if (points.length > 0) {
            const grouped = groupPointsBySubTopic(points);
            if (grouped.length === 1 || points.length <= 3) {
                // Simple flat list for single-topic or short lists
                parts.push(points.map(p => `- ${p.text}`).join('\n'));
            } else {
                // Sub-topic grouping for complex agenda items
                for (const group of grouped) {
                    parts.push(`### ${group.label}\n\n${group.points.map(p => `- ${p.text}`).join('\n')}`);
                }
            }
            points.forEach(p => renderedPointIds.add(p.id));
        }

        // Decisions sub-list
        if (decisions.length > 0) {
            const rows = decisions.map(d => {
                const owner = d.owner || '—';
                const due = d.due_date || '—';
                return `| ${d.id} | ${d.text} | ${owner} | ${due} |`;
            });
            parts.push(`**Decisions**\n\n| ID | Decision | Owner | Due |\n|----|----------|-------|-----|\n${rows.join('\n')}`);
            decisions.forEach(d => renderedDecisionIds.add(d.id));
        }

        // Actions sub-list (no Status column)
        if (actions.length > 0) {
            const rows = actions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            parts.push(`**Actions**\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
            actions.forEach(a => renderedActionIds.add(a.id));
        }

        sections.push(parts.join('\n\n'));
    }

    // General Items — unlinked items
    const unlinkedPoints = (json.notable_points || []).filter(p => !renderedPointIds.has(p.id));
    const unlinkedDecisions = (json.decisions || []).filter(d => !renderedDecisionIds.has(d.id));
    const unlinkedActions = (json.actions || []).filter(a => !renderedActionIds.has(a.id));

    if (unlinkedPoints.length > 0 || unlinkedDecisions.length > 0 || unlinkedActions.length > 0) {
        const parts: string[] = ['## General Items'];

        if (unlinkedPoints.length > 0) {
            parts.push(unlinkedPoints.map(p => `- ${p.text}`).join('\n'));
        }
        if (unlinkedDecisions.length > 0) {
            const rows = unlinkedDecisions.map(d => {
                const owner = d.owner || '—';
                const due = d.due_date || '—';
                return `| ${d.id} | ${d.text} | ${owner} | ${due} |`;
            });
            parts.push(`**Decisions**\n\n| ID | Decision | Owner | Due |\n|----|----------|-------|-----|\n${rows.join('\n')}`);
        }
        if (unlinkedActions.length > 0) {
            const rows = unlinkedActions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            parts.push(`**Actions**\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
        }

        sections.push(parts.join('\n\n'));
    }
}

// ─── Detailed renderer (governance prose) ────────────────────────

function renderDetailed(json: MinutesJSON, obsidianTasksFormat?: boolean): string {
    const sections = renderHeaderBlock(json, true);

    // Per-agenda-item content
    const hasAgenda = json.agenda?.length > 0;
    const hasLinkedItems = hasAgenda && hasAnyAgendaRef(json);

    if (hasLinkedItems) {
        renderDetailedAgendaGrouped(json, sections, obsidianTasksFormat);
    } else {
        // Flat layout
        if (hasAgenda) {
            const agendaLines = json.agenda.map((item, i) => `${i + 1}. ${item}`);
            sections.push(`## Agenda\n\n${agendaLines.join('\n')}`);
        }

        if (json.notable_points?.length > 0) {
            const pointLines = json.notable_points.map(p => `- ${p.text}`);
            sections.push(`## Key Points\n\n${pointLines.join('\n')}`);
        }

        if (json.decisions?.length > 0) {
            const rows = json.decisions.map(d => {
                const owner = d.owner || '—';
                return `| ${d.id} | ${d.text} | ${owner} |`;
            });
            sections.push(`## Decisions\n\n| ID | Decision | Owner |\n|----|----------|-------|\n${rows.join('\n')}`);
        }

        if (json.actions?.length > 0) {
            const rows = json.actions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            sections.push(`## Actions\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
        }
    }

    // Appendix (risks, deferred, open questions)
    const appendix = renderAppendix(json);
    if (appendix) sections.push(appendix);

    return sections.join('\n\n');
}

function renderDetailedAgendaGrouped(json: MinutesJSON, sections: string[], _obsidianTasksFormat?: boolean): void {
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

        const parts: string[] = [`## ${ref}. ${title}`];

        if (points.length === 0 && decisions.length === 0 && actions.length === 0) {
            parts.push(TRANSCRIPT_INCOMPLETE_AGENDA);
            sections.push(parts.join('\n\n'));
            continue;
        }

        // Prose paragraphs (governance voice — no bullets)
        if (points.length > 0) {
            parts.push(points.map(p => p.text).join('\n\n'));
            points.forEach(p => renderedPointIds.add(p.id));
        }

        // Compact Decisions table: ID | Decision | Owner (no Due, no confidence)
        if (decisions.length > 0) {
            const rows = decisions.map(d => {
                const owner = d.owner || '—';
                return `| ${d.id} | ${d.text} | ${owner} |`;
            });
            parts.push(`**Decisions**\n\n| ID | Decision | Owner |\n|----|----------|-------|\n${rows.join('\n')}`);
            decisions.forEach(d => renderedDecisionIds.add(d.id));
        }

        // Compact Actions table: ID | Action | Owner | Due (no Status, no confidence)
        if (actions.length > 0) {
            const rows = actions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            parts.push(`**Actions**\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
            actions.forEach(a => renderedActionIds.add(a.id));
        }

        sections.push(parts.join('\n\n'));
    }

    // General Items — unlinked items
    const unlinkedPoints = (json.notable_points || []).filter(p => !renderedPointIds.has(p.id));
    const unlinkedDecisions = (json.decisions || []).filter(d => !renderedDecisionIds.has(d.id));
    const unlinkedActions = (json.actions || []).filter(a => !renderedActionIds.has(a.id));

    if (unlinkedPoints.length > 0 || unlinkedDecisions.length > 0 || unlinkedActions.length > 0) {
        const parts: string[] = ['## General Items'];

        if (unlinkedPoints.length > 0) {
            parts.push(unlinkedPoints.map(p => p.text).join('\n\n'));
        }
        if (unlinkedDecisions.length > 0) {
            const rows = unlinkedDecisions.map(d => {
                const owner = d.owner || '—';
                return `| ${d.id} | ${d.text} | ${owner} |`;
            });
            parts.push(`**Decisions**\n\n| ID | Decision | Owner |\n|----|----------|-------|\n${rows.join('\n')}`);
        }
        if (unlinkedActions.length > 0) {
            const rows = unlinkedActions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            parts.push(`**Actions**\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
        }

        sections.push(parts.join('\n\n'));
    }
}

// ─── Guided renderer (LLM markdown passthrough) ─────────────────

function renderGuided(json: MinutesJSON, obsidianTasksFormat?: boolean, llmMarkdown?: string): string {
    // If LLM produced usable markdown, pass it through directly.
    // This preserves whatever structural conventions the LLM adopted from the reference.
    if (llmMarkdown && isUsableMarkdown(llmMarkdown)) {
        return stripConfidenceAnnotations(llmMarkdown);
    }
    // Fallback to standard rendering
    return renderStandard(json, obsidianTasksFormat);
}

export function buildMinutesJsonComment(json: MinutesJSON): string {
    return `<!-- AIO_MINUTES_JSON:${JSON.stringify(json)} -->`;
}

function yamlEscape(value: string): string {
    if (value === undefined || value === null) return '""';
    const trimmed = String(value).replace(/\r?\n/g, ' ').trim();
    const escaped = trimmed.replace(/"/g, '\\"');
    return `"${escaped}"`;
}

export function getFileFromVault(vault: Vault, path: string): TAbstractFile | null {
    return vault.getAbstractFileByPath(path);
}

export function isMarkdownFile(file: TAbstractFile | null): file is TFile {
    return !!file && file instanceof TFile;
}
