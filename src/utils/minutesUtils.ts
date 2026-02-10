import { normalizePath, TAbstractFile, TFile, Vault } from 'obsidian';
import { Action, GTDAction, MinutesJSON } from '../services/prompts/minutesPrompts';
import { MinutesDetailLevel } from '../core/constants';

export interface MinutesFrontmatterInput {
    json: MinutesJSON;
    fallbackTitle: string;
    fallbackDate: string;
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
            await vault.createFolder(current);
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

/**
 * Render readable markdown minutes from structured JSON.
 * Used as primary rendering when LLM produces JSON-only output,
 * and as fallback when LLM markdown is empty/truncated.
 */
export function renderMinutesFromJson(json: MinutesJSON, detailLevel: MinutesDetailLevel, obsidianTasksFormat?: boolean): string {
    const sections: string[] = [];
    const meta = json.metadata;

    // Header
    sections.push(`# ${meta?.title || 'Meeting Minutes'}`);

    // Metadata block
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

    if (detailLevel !== 'concise') {
        if (meta?.confidentiality_level && meta.confidentiality_level !== 'public') {
            metaLines.push(`**Confidentiality:** ${meta.confidentiality_level}`);
        }
        if (meta?.quorum_present !== null && meta?.quorum_present !== undefined) {
            metaLines.push(`**Quorum:** ${meta.quorum_present ? 'Yes' : 'No'}`);
        }
    }

    if (metaLines.length > 0) sections.push(metaLines.join('\n'));

    // Participants
    const attendees = json.participants?.filter(p => p.attendance !== 'apologies') || [];
    const apologies = json.participants?.filter(p => p.attendance === 'apologies') || [];

    if (attendees.length > 0) {
        const formatParticipant = (p: { name: string; role?: string; organisation?: string }) => {
            const parts = [p.name];
            if (p.role) parts.push(p.role);
            if (p.organisation) parts.push(p.organisation);
            return parts.length > 1 ? `${p.name} (${[p.role, p.organisation].filter(Boolean).join(', ')})` : p.name;
        };
        sections.push(`**Attendees:** ${attendees.map(formatParticipant).join(', ')}`);
    }
    if (apologies.length > 0) {
        sections.push(`**Apologies:** ${apologies.map(p => p.name).join(', ')}`);
    }

    // Agenda
    if (json.agenda?.length > 0 && detailLevel !== 'concise') {
        const agendaLines = json.agenda.map((item, i) => `${i + 1}. ${item}`);
        sections.push(`## Agenda\n\n${agendaLines.join('\n')}`);
    }

    // Key points / notable points (standard and detailed)
    if (json.notable_points?.length > 0 && detailLevel !== 'concise') {
        const pointLines = json.notable_points.map(p => {
            let line = `- ${p.text}`;
            if (detailLevel === 'detailed' && p.confidence !== 'high') line += ` *(${p.confidence} confidence)*`;
            return line;
        });
        sections.push(`## Key Points\n\n${pointLines.join('\n')}`);
    }

    // Decisions
    if (json.decisions?.length > 0) {
        if (detailLevel === 'concise') {
            const decisionLines = json.decisions.map(d => {
                const owner = d.owner ? ` (${d.owner})` : '';
                return `- **${d.id}** — ${d.text}${owner}`;
            });
            sections.push(`## Decisions\n\n${decisionLines.join('\n')}`);
        } else {
            const rows = json.decisions.map(d => {
                const due = d.due_date || '—';
                const owner = d.owner || '—';
                const extra = detailLevel === 'detailed' && d.confidence !== 'high' ? ` *(${d.confidence})*` : '';
                return `| ${d.id} | ${d.text}${extra} | ${owner} | ${due} |`;
            });
            sections.push(`## Decisions\n\n| ID | Decision | Owner | Due |\n|----|----------|-------|-----|\n${rows.join('\n')}`);
        }
    }

    // Actions
    if (json.actions?.length > 0) {
        if (detailLevel === 'concise') {
            const rows = json.actions.map(a => {
                const due = a.due_date || '—';
                return `| ${a.id} | ${a.text} | ${a.owner} | ${due} |`;
            });
            sections.push(`## Actions\n\n| ID | Action | Owner | Due |\n|----|--------|-------|-----|\n${rows.join('\n')}`);
        } else {
            const rows = json.actions.map(a => {
                const due = a.due_date || '—';
                const status = a.status || 'new';
                const extra = detailLevel === 'detailed' && a.confidence !== 'high' ? ` *(${a.confidence})*` : '';
                return `| ${a.id} | ${a.text}${extra} | ${a.owner} | ${due} | ${status} |`;
            });
            sections.push(`## Actions\n\n| ID | Action | Owner | Due | Status |\n|----|--------|-------|-----|--------|\n${rows.join('\n')}`);
        }
    }

    // Risks (standard and detailed)
    if (json.risks?.length > 0 && detailLevel !== 'concise') {
        const riskLines = json.risks.map(r => {
            let line = `- **${r.id}:** ${r.text}`;
            if (r.impact) line += ` — Impact: ${r.impact}`;
            if (r.mitigation) line += ` — Mitigation: ${r.mitigation}`;
            if (r.owner) line += ` (${r.owner})`;
            return line;
        });
        sections.push(`## Risks & Issues\n\n${riskLines.join('\n')}`);
    }

    // Open questions (standard and detailed)
    if (json.open_questions?.length > 0 && detailLevel !== 'concise') {
        const qLines = json.open_questions.map(q => {
            let line = `- **${q.id}:** ${q.text}`;
            if (q.owner) line += ` (${q.owner})`;
            return line;
        });
        sections.push(`## Open Questions\n\n${qLines.join('\n')}`);
    }

    // Deferred items (detailed only)
    if (json.deferred_items?.length > 0 && detailLevel === 'detailed') {
        const dLines = json.deferred_items.map(d => {
            let line = `- **${d.id}:** ${d.text}`;
            if (d.reason) line += ` — Reason: ${d.reason}`;
            return line;
        });
        sections.push(`## Deferred Items\n\n${dLines.join('\n')}`);
    }

    // GTD Processing (overlay — renders when present, ignores detailLevel)
    const gtd = json.gtd_processing;
    if (gtd) {
        if (gtd.next_actions?.length > 0) {
            // Group by context, sort keys alphabetically for deterministic output
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
    }

    return sections.join('\n\n');
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
