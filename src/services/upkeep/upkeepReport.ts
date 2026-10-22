/**
 * The optional vault upkeep report note. Saved only by the "Save report as note" button; a run never
 * writes it. The note is `Vault upkeep report.md` in the folder the user chose. It is created, or
 * replaced wholesale, ONLY when it is absent or its first line carries the signature; any other file
 * at that path refuses the write and is left untouched.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable, normalisePath, type ProtectedSource } from '../../core/protectedPaths';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { logger } from '../../utils/logger';
import type { Proposal, RunSummary } from './upkeepTasks';

export const REPORT_SIGNATURE = '<!-- aio:upkeep-report -->';
export const REPORT_FILE_NAME = 'Vault upkeep report.md';

/** The report path for a chosen folder, or an error. The folder may be empty (vault root). */
export function reportPathFor(folder: string, protectedFolders: ProtectedSource): Result<string> {
    const raw = folder.trim();
    if (/^([a-zA-Z]:|[\\/])/.test(raw) || raw.split(/[\\/]/).includes('..')) return err('upkeep-report-invalid');
    const dir = normalisePath(raw);
    if (dir.split('/').some((s) => s.startsWith('.'))) return err('upkeep-report-invalid');
    const path = dir === '' ? REPORT_FILE_NAME : `${dir}/${REPORT_FILE_NAME}`;
    if (!assertWritable(protectedFolders, 'create', path).ok) return err('protected-path');
    return ok(path);
}

const describe = (p: Proposal): string => {
    switch (p.kind) {
        case 'agent-index-stale': return `The agent index is out of date (${p.added} added, ${p.removed} removed, ${p.changed} changed${p.unreadable ? `, ${p.unreadable} unreadable` : ''}).`;
        case 'agent-index-refreshed': return `The agent index was refreshed (${p.path}).`;
        case 'inventory-differs': return `The Drive inventory differs: ${p.hubPath}`;
        case 'attachment-unreferenced': return `Nothing links to ${p.path}.`;
        case 'attachment-large': return `${p.path} is large (${p.referenceCount} references).`;
        case 'attachment-duplicate': return `Identical files: ${p.paths.join(', ')}`;
        case 'link-suggestion': return `${p.attachmentPath} may belong with ${p.notePath} (shared words: ${p.evidence.join(', ')}).`;
    }
};

/** Render the report text. Plain Markdown, no links, so it can never create or change a link by itself. */
export function renderReport(summary: RunSummary, proposals: readonly Proposal[], omitted: number): string {
    const lines = [REPORT_SIGNATURE, '# Vault upkeep report', '', `Run at ${summary.startedAt} (${summary.status}).`, ''];
    for (const outcome of summary.outcomes) lines.push(`- ${outcome.task}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    lines.push('');
    if (proposals.length === 0) lines.push('Nothing to review.');
    for (const p of proposals) lines.push(`- ${describe(p).replace(/[\r\n]+/g, ' ')}`);
    if (omitted > 0) lines.push('', `${omitted} more are not listed here.`);
    return lines.join('\n') + '\n';
}

/** Save the report. Never throws. */
export async function saveReport(plugin: AIOrganiserPlugin, text: string): Promise<Result<string>> {
    const path = reportPathFor(plugin.settings.upkeepReportFolder, plugin.settings.protectedFolders);
    if (!path.ok) return err(path.error);
    const vault = plugin.app.vault;
    try {
        const existing = vault.getAbstractFileByPath(path.value);
        if (!existing) {
            const slash = path.value.lastIndexOf('/');
            if (slash > 0 && !vault.getAbstractFileByPath(path.value.slice(0, slash))) await vault.createFolder(path.value.slice(0, slash));
            await vault.create(path.value, text);
            return ok(path.value);
        }
        if (!(existing instanceof TFile)) return err('upkeep-report-not-ours');
        const baseline = await vault.read(existing);
        if (baseline.split('\n', 1)[0].trim() !== REPORT_SIGNATURE) return err('upkeep-report-not-ours');
        const res = await applyNoteEdit(plugin, { kind: 'full-replace', filePath: path.value, baseline, nextContent: text }, { review: false });
        return res.ok ? ok(path.value) : err(res.error);
    } catch (e) {
        logger.error('Upkeep', 'Could not save the report', e);
        return err('write-failed');
    }
}
