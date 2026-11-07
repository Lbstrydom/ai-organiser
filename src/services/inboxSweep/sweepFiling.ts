/**
 * Filing: after a review, a note the person chose to file is moved into one of their PARA folders or put in the trash, in the same
 * step as its tasks. GTD clarifies and organises in one pass; this is that pass.
 *
 * Order, so a task is never left without its note:
 *   1. the review's choice is saved on the approval record (`Disposition.filing`), with the report and the ledger;
 *   2. tasks go to Google as before;
 *   3. only when every task from that note is safe (exported, or kept in the report) does the filing run (`filingReadiness`).
 * A send that fails leaves the note where it is; the next successful send files it. A task that can never be sent blocks the filing.
 *
 * Safety: trash is Obsidian's own (`fileManager.trashFile`, recoverable per the person's settings), and only for a note that is
 * unchanged since the review, so later edits are never thrown away. A move uses `fileManager.renameFile`, so links follow, and never
 * overwrites a note of the same name. Both are refused for a protected note, a protected destination, or a note linked from a
 * protected folder. A refused or impossible filing is marked 'skipped' and said once; it never retries forever.
 */
import { Notice, TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { assertWritable, isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { referrersProtectedActive } from '../../utils/protectedGuard';
import { isFeatureEnabled } from '../featureService';
import { logger } from '../../utils/logger';
import type { ParaKind, ParaRoot } from '../projects/paraRoots';
import { normaliseParaRoots } from '../projects/paraRoots';
import { filingReadiness, type ApprovalRecord, type Disposition } from './sweepLedger';
import { runExclusive } from './sweepCommit';
import { buildSnapshot } from './noteSnapshot';

/** The PARA kinds a note can be filed into (not back into the inbox). */
const FILING_KINDS: readonly ParaKind[] = ['projects', 'areas', 'reference', 'archive'];
/** How deep below a root the folder list goes: the root, its folders and theirs. */
const MAX_DEPTH = 2;
/** The list is a dropdown, not a vault map. */
const MAX_FOLDERS = 200;

/**
 * The folders a note may be filed into: each projects / areas / reference / archive root and its folders up to two levels down,
 * root order kept, never a protected folder or one inside it. Empty when no PARA roots are set (then only the trash is offered).
 */
export function filingFolders(roots: readonly ParaRoot[], folders: readonly string[], protectedFolders: readonly string[]): string[] {
    const out: string[] = [];
    const isProtected = (p: string): boolean => protectedFolders.some((f) => isInsideOrEqual(p, f));
    for (const root of roots.filter((r) => FILING_KINDS.includes(r.kind))) {
        const base = normalisePath(root.path);
        const depthOf = (p: string): number => p.slice(base.length).split('/').filter(Boolean).length;
        const under = folders
            .map(normalisePath)
            .filter((p) => p !== '' && isInsideOrEqual(p, base) && depthOf(p) <= MAX_DEPTH && !p.split('/').some((s) => s.startsWith('.')))
            .sort((a, b) => a.localeCompare(b));
        for (const p of under) if (!isProtected(p) && !out.includes(p)) out.push(p);
    }
    return out.slice(0, MAX_FOLDERS);
}

/** The folders the review offers for this vault, from the shared PARA roots. */
export function filingFoldersFor(plugin: AIOrganiserPlugin): string[] {
    const files = plugin.app?.vault?.getAllLoadedFiles?.() ?? [];
    const folders = files.filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path);
    return filingFolders(normaliseParaRoots(plugin.settings.paraRoots), folders, plugin.settings.protectedFolders ?? []);
}

type Outcome = { kind: 'moved' } | { kind: 'trashed' } | { kind: 'skipped'; reason: 'changed' | 'protected' | 'name-taken' | 'folder-gone' | 'blocked' | 'gone' | 'failed'; name: string; folder?: string };

const nameOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

async function fileOne(plugin: AIOrganiserPlugin, d: Disposition): Promise<Outcome> {
    const name = nameOf(d.sourcePath);
    const file = plugin.app.vault.getAbstractFileByPath(d.sourcePath);
    if (!(file instanceof TFile)) return { kind: 'skipped', reason: 'gone', name };
    const filing = d.filing!;
    if (filing.type === 'trash') {
        if (!assertWritable(plugin.settings, 'delete', file.path).ok) return { kind: 'skipped', reason: 'protected', name };
        // Only the note as it was reviewed goes to the trash: an edit made since then is kept.
        const snap = await buildSnapshot(file.path, await plugin.app.vault.read(file), '');
        if (snap.contentHash !== d.sourceHash) return { kind: 'skipped', reason: 'changed', name };
        await plugin.app.fileManager.trashFile(file);
        return { kind: 'trashed' };
    }
    const folder = normalisePath(filing.folder);
    if (!(plugin.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) return { kind: 'skipped', reason: 'folder-gone', name, folder };
    const target = `${folder}/${file.name}`;
    if (normalisePath(file.path) === normalisePath(target)) return { kind: 'moved' };
    if (plugin.app.vault.getAbstractFileByPath(target)) return { kind: 'skipped', reason: 'name-taken', name, folder };
    // The whole footprint: the note, where it goes, and the notes whose links the move rewrites.
    if (!assertWritable(plugin.settings, 'rename', [file.path, target, { path: folder, folder: false }]).ok || referrersProtectedActive(plugin.app, file.path)) {
        return { kind: 'skipped', reason: 'protected', name };
    }
    await plugin.app.fileManager.renameFile(file, target);
    return { kind: 'moved' };
}

/** The record as stored now (a rename during a filing remaps it), with one disposition marked. */
function markFiled(plugin: AIOrganiserPlugin, runId: string, index: number, filed: 'done' | 'skipped'): void {
    const list = plugin.settings.sweepApprovals;
    const i = list.findIndex((r) => r.runId === runId);
    if (i === -1) return;
    const record = list[i];
    const dispositions = record.dispositions.map((d, j) => (j === index ? { ...d, filed } : d));
    list[i] = { ...record, dispositions };
}

const googleOn = (plugin: AIOrganiserPlugin): boolean => isFeatureEnabled(plugin.settings, 'google-tasks-export') && !!plugin.settings.tasksListId;

/** Run every filing whose tasks are safe. Never throws; tells the person what was filed and what was left, once. */
export function runPendingFiling(plugin: AIOrganiserPlugin): Promise<void> {
    return runExclusive(async () => {
        const t = plugin.t.inboxSweep;
        let moved = 0;
        let trashed = 0;
        const told: string[] = [];
        try {
            const records: ApprovalRecord[] = [...plugin.settings.sweepApprovals];
            for (const record of records) {
                for (let index = 0; index < record.dispositions.length; index++) {
                    // Read the live disposition each time: an earlier move in this loop may have remapped paths in this record.
                    const live = plugin.settings.sweepApprovals.find((r) => r.runId === record.runId);
                    const d = live?.dispositions[index];
                    if (!live || !d) continue;
                    const ready = filingReadiness(live, d, googleOn(plugin));
                    if (ready === 'none' || ready === 'wait') continue;
                    let out: Outcome;
                    try {
                        out = ready === 'blocked' ? { kind: 'skipped', reason: 'blocked', name: nameOf(d.sourcePath) } : await fileOne(plugin, d);
                    } catch (e) {
                        logger.error('Sweep', 'Filing failed', e);
                        out = { kind: 'skipped', reason: 'failed', name: nameOf(d.sourcePath) };
                    }
                    markFiled(plugin, record.runId, index, out.kind === 'skipped' ? 'skipped' : 'done');
                    await plugin.saveSettings();
                    if (out.kind === 'moved') moved++;
                    else if (out.kind === 'trashed') trashed++;
                    else if (out.reason !== 'gone') told.push(t.filingSkipped[out.reason].replace('{name}', out.name).replace('{folder}', out.folder ?? ''));
                }
            }
        } catch (e) {
            logger.error('Sweep', 'Filing stopped', e);
        }
        if (moved + trashed > 0) new Notice(t.filingDoneNotice.replace('{moved}', String(moved)).replace('{trashed}', String(trashed)), 7000);
        for (const line of told) new Notice(line, 12000);
    });
}
