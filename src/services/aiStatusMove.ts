/**
 * Move AI status marks to `aio-status`: the opt-in migration after the user switches `aiStatusProperty`.
 *
 * Scan, then review, then apply. Nothing is written until the person ticks items and presses Apply, and nothing runs on
 * its own. Each note is one line-level edit: `status: processed` becomes `aio-status: processed` in the same place, and
 * every other byte stays. An adopted project becomes `status: active` and gains `aio-status: processed`. A dashboard
 * (`.base`) has its `status == "processed"` filter retargeted to `note["aio-status"] == "processed"`. An item whose
 * file changed after the scan is skipped, never forced. Protected folders are never scanned or written.
 */
import { App, TFile } from 'obsidian';
import * as yaml from 'js-yaml';
import { Result, ok, err } from '../core/result';
import { AIO_STATUS_KEY, retargetStatusFilter } from '../core/aiStatus';
import { isAiProcessingMark } from '../core/constants';
import { assertWritableActive, isProtectedActive } from '../core/protectedPaths';
import { insertFrontmatterKeys, readFrontmatterRecord, renameFrontmatterScalarKey, replaceFrontmatterScalar } from '../utils/frontmatterKeys';
import { AIO_ROLE_KEY } from './projects/projectIndex';
import { logger } from '../utils/logger';

export interface AiStatusMoveItem {
    path: string;
    kind: 'note' | 'dashboard';
    /** The text the plan was made from: the apply refuses when the file no longer matches it */
    baseline: string;
    next: string;
    /** The mark moved (notes only) */
    mark?: string;
    /** An adopted project: its `status` becomes `active` while the mark moves */
    becomesActive?: boolean;
}

export interface NoteMovePlan { next: string; mark: string; becomesActive: boolean }

/** The edit for one note whose `status` is the AI's mark. */
export function planNoteMove(text: string): Result<NoteMovePlan> {
    const fm = readFrontmatterRecord(text);
    const mark = fm?.status;
    if (!fm || !isAiProcessingMark(mark)) return err('no-ai-status-mark');
    if (Object.hasOwn(fm, AIO_STATUS_KEY)) return err('aio-status-exists');
    if (fm[AIO_ROLE_KEY] === 'project') {
        const replaced = replaceFrontmatterScalar(text, 'status', isAiProcessingMark, 'active');
        if (!replaced.ok) return err('ai-status-not-movable');
        const inserted = insertFrontmatterKeys(replaced.value, [[AIO_STATUS_KEY, mark]]);
        return inserted.ok ? ok({ next: inserted.value.text, mark, becomesActive: true }) : err('ai-status-not-movable');
    }
    const renamed = renameFrontmatterScalarKey(text, 'status', AIO_STATUS_KEY, isAiProcessingMark);
    return renamed.ok ? ok({ next: renamed.value, mark, becomesActive: false }) : err('ai-status-not-movable');
}

/** The edit for one dashboard whose filter compares `status` with a mark; refused when nothing matches or YAML breaks. */
export function planDashboardMove(text: string): Result<string> {
    const next = retargetStatusFilter(text, AIO_STATUS_KEY);
    if (next === text) return err('no-status-filter');
    try {
        const parsed: unknown = yaml.load(next);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return err('dashboard-unreadable');
    } catch {
        return err('dashboard-unreadable');
    }
    return ok(next);
}

/** Every note and dashboard that would change, sorted by path. Reads only; protected folders are left out. */
export async function scanAiStatusMoves(app: App): Promise<Result<AiStatusMoveItem[]>> {
    try {
        const items: AiStatusMoveItem[] = [];
        for (const file of app.vault.getMarkdownFiles()) {
            if (!isAiProcessingMark(app.metadataCache.getFileCache(file)?.frontmatter?.status)) continue;
            if (isProtectedActive(file.path)) continue;
            const baseline = await app.vault.cachedRead(file);
            const plan = planNoteMove(baseline);
            if (plan.ok) items.push({ path: file.path, kind: 'note', baseline, ...plan.value });
        }
        for (const file of app.vault.getFiles()) {
            if (file.extension !== 'base' || isProtectedActive(file.path)) continue;
            const baseline = await app.vault.cachedRead(file);
            const plan = planDashboardMove(baseline);
            if (plan.ok) items.push({ path: file.path, kind: 'dashboard', baseline, next: plan.value });
        }
        return ok(items.sort((a, b) => a.path.localeCompare(b.path)));
    } catch (e) {
        logger.error('AiStatus', 'Scan failed', e);
        return err('ai-status-scan-failed');
    }
}

export interface AiStatusMoveSummary {
    moved: string[];
    /** Changed after the scan, gone, or now protected: left as it is */
    skipped: string[];
    failed: string[];
}

const CHANGED = 'ai-status-file-changed';

/** Apply the ticked items, one file at a time. Never rejects. */
export async function applyAiStatusMoves(app: App, items: readonly AiStatusMoveItem[]): Promise<Result<AiStatusMoveSummary>> {
    const summary: AiStatusMoveSummary = { moved: [], skipped: [], failed: [] };
    for (const item of items) {
        const file = app.vault.getAbstractFileByPath(item.path);
        if (!(file instanceof TFile)) { summary.skipped.push(item.path); continue; }
        if (!assertWritableActive('modify', file.path).ok) { summary.skipped.push(item.path); continue; }
        try {
            await app.vault.process(file, (current) => {
                if (current !== item.baseline) throw new Error(CHANGED);
                return item.next;
            });
            summary.moved.push(item.path);
        } catch (e) {
            if (e instanceof Error && e.message === CHANGED) summary.skipped.push(item.path);
            else { logger.error('AiStatus', `Move failed for ${item.path}`, e); summary.failed.push(item.path); }
        }
    }
    return ok(summary);
}
