import { normalizePath, TAbstractFile, TFile, Vault } from 'obsidian';
import { Action, MinutesJSON } from '../services/prompts/minutesPrompts';

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
    lines.push(`aio_type: meeting`);
    lines.push(`aio_meeting_title: ${yamlEscape(title)}`);
    lines.push(`aio_meeting_date: ${yamlEscape(date)}`);
    lines.push(`aio_meeting_start_time: ${yamlEscape(json.metadata?.start_time || '')}`);
    lines.push(`aio_meeting_end_time: ${yamlEscape(json.metadata?.end_time || '')}`);
    lines.push(`aio_meeting_timezone: ${yamlEscape(json.metadata?.timezone || '')}`);
    lines.push(`aio_context: ${yamlEscape(json.metadata?.meeting_context || '')}`);
    lines.push(`aio_output_audience: ${yamlEscape(json.metadata?.output_audience || '')}`);
    lines.push(`aio_confidentiality: ${yamlEscape(json.metadata?.confidentiality_level || '')}`);
    lines.push(`aio_chair: ${yamlEscape(json.metadata?.chair || '')}`);
    lines.push(`aio_location: ${yamlEscape(json.metadata?.location || '')}`);
    lines.push(`aio_actions_count: ${json.actions?.length ?? 0}`);
    lines.push(`aio_decisions_count: ${json.decisions?.length ?? 0}`);
    lines.push(`aio_has_tbc: ${hasTbc ? 'true' : 'false'}`);
    lines.push(`aio_quorum: ${json.metadata?.quorum_present ?? 'null'}`);

    if (attendees.length > 0) {
        lines.push(`aio_attendees:`);
        attendees.forEach(a => lines.push(`  - ${yamlEscape(a)}`));
    }

    if (apologies.length > 0) {
        lines.push(`aio_apologies:`);
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
