/**
 * Date-range post-filter for providers that cannot take a date window in the request
 * (Claude web search: llm-option-fidelity D7).
 *
 * The windows match the other providers: Tavily and Bright Data map `recent` to 7 days and
 * `year` to 365. A page's date comes from free-form `page_age`, so only two shapes are trusted
 * (ISO-8601 and "Month D, YYYY"); anything else is *undated*. Undated results are KEPT and
 * counted, never dropped, because dropping them could empty the list.
 */
import type { SearchConstraintReport, SearchResult } from './researchTypes';

export type DateRangeSetting = 'recent' | 'year' | 'any';

const DAY_MS = 86_400_000;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Month index for a full name, a three-letter abbreviation or 'sept'; undefined otherwise. */
function monthIndex(name: string): number | undefined {
    const n = name.toLowerCase();
    const i = MONTH_NAMES.findIndex(m => m === n || m.slice(0, 3) === n || (n === 'sept' && m === 'september'));
    return i >= 0 ? i : undefined;
}

/** Window in days for a setting, or undefined when no window applies. */
export function dateRangeWindowDays(range: DateRangeSetting | undefined): number | undefined {
    if (range === 'recent') return 7;
    if (range === 'year') return 365;
    return undefined;
}

function utcDay(y: number, m: number, d: number): number | undefined {
    const ms = Date.UTC(y, m, d);
    const back = new Date(ms);
    return back.getUTCFullYear() === y && back.getUTCMonth() === m && back.getUTCDate() === d ? ms : undefined;
}

/** Parse a `page_age` value to a UTC midnight timestamp, or undefined when it is not a trusted format. */
export function parsePageAge(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const s = value.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
    if (iso) return utcDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const long = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (long) {
        const month = monthIndex(long[1]);
        if (month === undefined) return undefined;
        return utcDay(Number(long[3]), month, Number(long[2]));
    }
    return undefined;
}

export interface DateRangeOutcome {
    results: SearchResult[];
    report: SearchConstraintReport;
}

/**
 * Filter results to the window. The boundary is inclusive at day granularity, measured back
 * from `now` (UTC): a page dated exactly N days ago is kept.
 *  - `applied`:     every result had a parseable date and was checked.
 *  - `partial`:     some results were undated; they were kept and counted.
 *  - `unsupported`: no result had a parseable date, so nothing could be checked.
 */
export function applyDateRange(results: SearchResult[], range: DateRangeSetting | undefined, now: number = Date.now()): DateRangeOutcome {
    const days = dateRangeWindowDays(range);
    if (days === undefined) {
        return { results, report: { constraint: 'dateRange', outcome: 'applied', undatedCount: 0, filteredCount: 0 } };
    }
    const today = new Date(now);
    const cutoff = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - days * DAY_MS;

    let undated = 0;
    let dated = 0;
    const kept: SearchResult[] = [];
    for (const r of results) {
        const page = parsePageAge(r.date);
        if (page === undefined) {
            undated++;
            kept.push(r);
            continue;
        }
        dated++;
        if (page >= cutoff) kept.push(r);
    }
    const outcome: SearchConstraintReport['outcome'] =
        results.length > 0 && dated === 0 ? 'unsupported' : undated > 0 ? 'partial' : 'applied';
    return {
        results: kept,
        report: { constraint: 'dateRange', outcome, undatedCount: undated, filteredCount: results.length - kept.length },
    };
}

const SEVERITY: Record<SearchConstraintReport['outcome'], number> = { applied: 0, partial: 1, unsupported: 2 };

/** Merge reports for one constraint (continuations, parallel queries, providers): worst outcome wins, counts add. */
export function mergeConstraintReports(...lists: Array<SearchConstraintReport[] | undefined>): SearchConstraintReport[] {
    const byConstraint = new Map<SearchConstraintReport['constraint'], SearchConstraintReport>();
    for (const list of lists) {
        for (const r of list ?? []) {
            const existing = byConstraint.get(r.constraint);
            if (!existing) {
                byConstraint.set(r.constraint, { ...r });
                continue;
            }
            existing.undatedCount += r.undatedCount;
            existing.filteredCount += r.filteredCount;
            if (SEVERITY[r.outcome] > SEVERITY[existing.outcome]) existing.outcome = r.outcome;
        }
    }
    return [...byConstraint.values()];
}
