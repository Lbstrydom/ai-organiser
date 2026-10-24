/**
 * A rough cost range shown BEFORE anything is sent. One constants table, so the numbers are
 * reviewable and change in one place. These are estimates, not quotes: a user on an Azure plan or a
 * local provider pays something else, and the wording says so. Pure.
 */

/** USD, deliberately wide. */
export const COST_TABLE = {
    transcribePerMinute: { low: 0.003, high: 0.012 },
    digitisePerImage: { low: 0.002, high: 0.03 },
    tagPerCapture: { low: 0.0005, high: 0.01 },
    /** Compressed audio runs from ~10 MB/min (uncompressed wav) down to ~0.5 MB/min (speech codec). */
    mbPerMinute: { low: 0.5, high: 10 },
} as const;

export interface EstimateInput {
    captures: number;
    audioMB: number;
    images: number;
}

export interface CostEstimate {
    lowUsd: number;
    highUsd: number;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

export function estimateCost(input: EstimateInput): CostEstimate {
    const minutesHigh = input.audioMB / COST_TABLE.mbPerMinute.low;
    const minutesLow = input.audioMB / COST_TABLE.mbPerMinute.high;
    const low =
        minutesLow * COST_TABLE.transcribePerMinute.low +
        input.images * COST_TABLE.digitisePerImage.low +
        input.captures * COST_TABLE.tagPerCapture.low;
    const high =
        minutesHigh * COST_TABLE.transcribePerMinute.high +
        input.images * COST_TABLE.digitisePerImage.high +
        input.captures * COST_TABLE.tagPerCapture.high;
    return { lowUsd: cents(low), highUsd: Math.max(cents(high), cents(low)) };
}

/** Human text. Azure and local providers are priced differently, so no figure is claimed for them. */
export function formatEstimate(estimate: CostEstimate, provider: 'azure' | 'local' | 'cloud'): string {
    if (provider === 'azure') return 'depends on your Azure plan';
    if (provider === 'local') return 'no per-call charge from a local provider';
    if (estimate.highUsd <= 0.01) return 'about 1 cent or less';
    return `about $${estimate.lowUsd.toFixed(2)} to $${estimate.highUsd.toFixed(2)}`;
}
