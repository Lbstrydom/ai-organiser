import { describe, it, expect } from 'vitest';
import { storyKey } from '../src/services/newsletter/newsletterStoryLedger';
import {
    SIMILARITY_THRESHOLD,
    keyTokens,
    similarity,
    findSimilarKey,
} from '../src/services/newsletter/newsletterStoryIdentity';

const sim = (a: string, b: string) => similarity(keyTokens(storyKey(a)), keyTokens(storyKey(b)));

/**
 * These pairs are REAL headlines taken from 7 consecutive days of one user's
 * actual newsletter briefs. They are the calibration for SIMILARITY_THRESHOLD:
 * every SAME pair must merge and every DIFFERENT pair must not, so the threshold
 * cannot be nudged without a test failing.
 */
const SAME: [string, string][] = [
    ['Netherlands repatriates 86 tonnes of gold from the US',
     'Netherlands repatriates 78 tonnes of gold from US and Canada'],
    ['Sony and Warner sue Anthropic for music copyright infringement',
     'Sony Music and Warner sue Anthropic'],
    ['AI adoption in Dutch healthcare called a "ticking time bomb"',
     'AI in healthcare called a "ticking time bomb"'],
    ['Apple CEO transition — Ternus takes over from Cook',
     'Apple CEO transition: Cook hands reins to Ternus'],
    ['Trump Secures Venezuela Oil Deal', 'US-Venezuela oil deal'],
    ['Nepal-Tibet glacial floods kill over 1,000', 'Nepal-Tibet glacial flood disaster'],
    ['Anthropic pauses training after rogue agent hacks its own systems',
     'Anthropic pauses AI training after rogue-agent incidents'],
    ['Google escapes forced ad tech breakup',
     'Google escapes forced breakup in second antitrust ruling'],
    ["OpenAI's Hugging Face postmortem raises safety culture concerns",
     "OpenAI's Hugging Face hack exposes safety culture failures"],
    ["Trump's Venezuela oil deal draws \"colonial cronyism\" criticism",
     'Trump Secures Venezuela Oil Deal'],
];

/**
 * The dangerous direction. A false merge SUPPRESSES a genuinely new story and
 * the reader can never tell; a missed merge merely repeats one, which is the
 * behaviour this feature replaces. So these must stay apart.
 */
const DIFFERENT: [string, string][] = [
    // The highest-scoring false pair in the real corpus — shares only
    // "post revenue growth".
    ['Broadcom posts 86% revenue growth but misses guidance',
     "China's Z.ai posts 2,736% revenue growth"],
    ['Nvidia acquires Hugging Face for $12.9 billion',
     'OpenAI launches GPT-6 Astra, its most powerful model yet'],
    ['Dutch central bank cuts hundreds of jobs', 'Uber announces layoffs amid cost pressure'],
    ['Federal Reserve signals rate hike within two weeks',
     'Yen surges on Bank of Japan rate signals'],
    ['Taiwan links 166 semiconductor espionage cases to China',
     'Spain dismisses Morocco\'s role in Ceuta border surge'],
];

describe('story identity, calibrated on real headlines', () => {
    it('merges every real continuing story', () => {
        const missed = SAME.filter(([a, b]) => sim(a, b) < SIMILARITY_THRESHOLD);
        for (const [a, b] of SAME) {
            expect(sim(a, b), `should merge:\n  "${a}"\n  "${b}"`).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
        }
        expect(missed).toEqual([]);
    });

    it('keeps genuinely different stories apart', () => {
        for (const [a, b] of DIFFERENT) {
            expect(sim(a, b), `must NOT merge:\n  "${a}"\n  "${b}"`).toBeLessThan(SIMILARITY_THRESHOLD);
        }
    });

    it('leaves clear margin on both sides of the threshold', () => {
        // If these ever converge, the token normalisation has drifted and the
        // threshold is no longer separating signal from noise.
        const worstSame = Math.min(...SAME.map(([a, b]) => sim(a, b)));
        const bestDifferent = Math.max(...DIFFERENT.map(([a, b]) => sim(a, b)));
        expect(worstSame).toBeGreaterThan(bestDifferent);
    });
});

describe('findSimilarKey', () => {
    const cands = (...titles: string[]): [string, Set<string>][] =>
        titles.map((t) => [storyKey(t), keyTokens(storyKey(t))] as [string, Set<string>]);

    it('returns the best match, not merely the first over the threshold', () => {
        const list = cands(
            'Apple CEO transition: Cook hands reins to Ternus',
            'Netherlands repatriates 78 tonnes of gold from US and Canada',
        );
        const t = keyTokens(storyKey('Netherlands repatriates 86 tonnes of gold from the US'));
        expect(findSimilarKey(t, list)).toBe(storyKey('Netherlands repatriates 78 tonnes of gold from US and Canada'));
    });

    it('returns null when nothing clears the threshold', () => {
        const list = cands('Uber announces layoffs amid cost pressure');
        expect(findSimilarKey(keyTokens(storyKey('James Webb reveals galaxy collision')), list)).toBeNull();
    });

    it('is order-independent', () => {
        const titles = [
            'Apple CEO transition: Cook hands reins to Ternus',
            'Netherlands repatriates 78 tonnes of gold from US and Canada',
            'Sony Music and Warner sue Anthropic',
        ];
        const t = keyTokens(storyKey('Netherlands repatriates 86 tonnes of gold from the US'));
        const forward = findSimilarKey(t, cands(...titles));
        const backward = findSimilarKey(t, cands(...[...titles].reverse()));
        expect(forward).toBe(backward);
    });

    it('an empty candidate list yields null', () => {
        expect(findSimilarKey(keyTokens('a-b-c'), [])).toBeNull();
    });
});

describe('similarity', () => {
    it('is 1 for identical sets and 0 when either is empty', () => {
        expect(similarity(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1);
        expect(similarity(new Set(), new Set(['a']))).toBe(0);
        expect(similarity(new Set(['a']), new Set())).toBe(0);
    });

    it('is symmetric', () => {
        const a = new Set(['a', 'b', 'c']);
        const b = new Set(['b', 'c', 'd']);
        expect(similarity(a, b)).toBe(similarity(b, a));
    });
});
