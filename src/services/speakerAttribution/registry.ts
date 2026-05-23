/**
 * Strategy registry (plan F5, R1 H3).
 *
 * Single dispatch point: callers ask for a strategy by language code; we
 * resolve to the right implementation or fall back to NoOp.
 *
 * Adding a new language strategy:
 *   1. Implement `SpeakerAttributionStrategy` in a sibling file (e.g.
 *      `germanStrategy.ts`).
 *   2. Add a `case` in `getStrategyForLanguage`.
 *   3. Add a unit test for the regex/lexical rules of that language.
 * — no orchestrator changes required.
 */

import type { SpeakerAttributionStrategy } from './types';
import { englishAttributionStrategy } from './englishStrategy';
import { NoOpAttributionStrategy } from './noOpStrategy';

/**
 * Resolve the strategy for a BCP-47 language tag. Matches the language
 * subtag (e.g. `'en-US'` → English) — region-specific differences are
 * handled inside the strategy when needed.
 *
 * `'und'` (undetermined — Whisper's fallback when detection fails) routes
 * to NoOp; callers see the `unsupported-language` flag rather than a
 * silent attribution attempt.
 */
export function getStrategyForLanguage(languageCode: string): SpeakerAttributionStrategy {
    const lang = (languageCode || 'und').toLowerCase().split('-')[0];
    switch (lang) {
        case 'en':
            return englishAttributionStrategy;
        default:
            return new NoOpAttributionStrategy(languageCode);
    }
}
