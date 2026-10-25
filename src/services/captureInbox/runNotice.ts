/**
 * The sentence set shown when a capture run ends. Pure, so the counting rules are testable.
 *
 * "To review" counts only captures that now wait for a decision: a failed or set-aside capture was attempted, but it is
 * not "processed" in the sense the user means. What is left says why: beyond this run's limit only when the run was
 * really capped; otherwise the capture simply matured while the run was going and a new run picks it up.
 */
import { plural } from '../../utils/plural';
import type { RunSummary } from './captureProcessor';

export interface RunNoticeText {
    summaryNotice: string;
    runLeftover: string;
    runMatured: string;
    runSettling: string;
    runSkipped: string;
}

export function runNoticeLines(
    t: RunNoticeText,
    summary: Pick<RunSummary, 'awaitingReview' | 'failed'>,
    skipped: number,
    after: { ready: number; settling: number },
    /** The confirmation listed more captures than the run's limit allowed (some were left for later by design) */
    capped: boolean,
): string[] {
    return [
        t.summaryNotice.replace('{review}', String(summary.awaitingReview)).replace('{failed}', String(summary.failed)).replace('{skipped}', String(skipped)),
        after.ready > 0 ? plural(capped ? t.runLeftover : t.runMatured, after.ready).replace('{count}', String(after.ready)) : '',
        after.settling > 0 ? plural(t.runSettling, after.settling).replace('{count}', String(after.settling)) : '',
        skipped > 0 ? t.runSkipped : '',
    ].filter(Boolean);
}
