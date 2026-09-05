/**
 * Story identity matching — how two headlines are judged to be the same story.
 *
 * WHY THIS EXISTS: exact key equality is far too strict for real newsletters.
 * Measured against 219 real stories across 7 days of one user's vault, exact
 * normalised-token-set equality caught 2 continuations. At least 10 more were
 * obviously the same running story to a human eye:
 *
 *     "Netherlands repatriates 86 tonnes of gold from the US"
 *     "Netherlands repatriates 78 tonnes of gold from US and Canada"
 *
 *     "Sony and Warner sue Anthropic for music copyright infringement"
 *     "Sony Music and Warner sue Anthropic"
 *
 * A continuing story is precisely the case where the headline gains or loses a
 * qualifier, so requiring the token set to be identical means the memory feature
 * misses the cases it exists for and the reader gets the story retold.
 *
 * So identity is a SIMILARITY judgement over the normalised token sets, with a
 * threshold calibrated on that real data (see the accompanying bench test).
 */

/**
 * Minimum Jaccard overlap of normalised token sets for two headlines to count as
 * the same story.
 *
 * MEASURED, not guessed, and the gap is narrow — which is worth knowing before
 * anyone changes it. Across 219 real stories from 7 consecutive days:
 *
 *   weakest genuine continuation   0.444   "Trump's Venezuela oil deal draws
 *                                           'colonial cronyism' criticism"
 *                                       vs "Trump Secures Venezuela Oil Deal"
 *   strongest false pair           0.375   "Broadcom posts 86% revenue growth"
 *                                       vs "China's Z.ai posts 2,736% revenue
 *                                           growth"  (shares only "post revenue
 *                                           growth")
 *
 * 0.42 sits between them. `newsletterStoryIdentity.test.ts` pins both ends with
 * the real headlines, so the threshold cannot be nudged without a failure.
 *
 * The two directions are NOT equally bad, which is what should guide any future
 * tuning. Too LOW merges two different stories and silently SUPPRESSES a real
 * one — the reader never learns it existed. Too HIGH merely repeats a story,
 * which is exactly the behaviour that existed before this feature. When in
 * doubt, err high.
 */
export const SIMILARITY_THRESHOLD = 0.42;

/** Split a story key back into its normalised tokens. */
export function keyTokens(key: string): Set<string> {
    return new Set(key.split('-').filter(Boolean));
}

/** Jaccard overlap of two token sets: |A ∩ B| / |A ∪ B|. */
export function similarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const t of a) if (b.has(t)) intersection++;
    return intersection / (a.size + b.size - intersection);
}

/**
 * Find the existing key that best matches `tokens`, or null.
 *
 * Returns the single best match rather than the first over the threshold, so the
 * result does not depend on iteration order — the function has to be
 * deterministic because it decides what the reader is told. Ties break on the
 * lexicographically smaller key for the same reason.
 */
export function findSimilarKey(
    tokens: Set<string>,
    candidates: Iterable<readonly [string, Set<string>]>,
    threshold: number = SIMILARITY_THRESHOLD,
): string | null {
    let bestKey: string | null = null;
    let bestScore = 0;
    for (const [key, candidateTokens] of candidates) {
        const score = similarity(tokens, candidateTokens);
        if (score < threshold) continue;
        if (score > bestScore || (score === bestScore && bestKey !== null && key < bestKey)) {
            bestScore = score;
            bestKey = key;
        }
    }
    return bestKey;
}
