/**
 * Is `storyKey` (exact normalised token-set) strict enough to MISS real
 * continuing stories?
 *
 * Exact-key matching found only 0.9% repeats across 7 real days, which is far
 * below the user's lived experience of "the same story with one sentence added".
 * That gap is the thing to measure: if many stories have a high but not perfect
 * token overlap with a prior day's story, the key is too strict and the memory
 * feature will under-trigger on exactly the cases it exists for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { storyKey } from '../../src/services/newsletter/newsletterStoryLedger';
import type { StoryLedger } from '../../src/services/newsletter/newsletterMemoryTypes';

const DATA = 'C:/obsidian/Second Brain/.obsidian/plugins/ai-organiser/data.json';

const tokens = (s: string) => new Set(storyKey(s).split('-').filter(Boolean));

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

describe('how strict is storyKey on real continuing stories?', () => {
    it('measures best cross-day title similarity', () => {
        const d = JSON.parse(readFileSync(DATA, 'utf8'));
        const ledger: StoryLedger = d['newsletter-story-ledger'];
        const days = Object.keys(ledger.buckets).sort();

        const prior: { day: string; title: string; toks: Set<string> }[] = [];
        const buckets = { exact: 0, high: 0, mid: 0, low: 0, none: 0 };
        const examples: string[] = [];

        for (const day of days) {
            const todays = ledger.buckets[day].stories.map(s => ({
                day, title: s.title, toks: tokens(s.title), key: s.key,
            }));
            for (const s of todays) {
                let best = 0;
                let bestTitle = '';
                let bestDay = '';
                for (const p of prior) {
                    const j = jaccard(s.toks, p.toks);
                    if (j > best) { best = j; bestTitle = p.title; bestDay = p.day; }
                }
                if (best >= 0.999) buckets.exact++;
                else if (best >= 0.5) {
                    buckets.high++;
                    examples.push(`  ${best.toFixed(2)}  ${day} "${s.title}"\n         vs ${bestDay} "${bestTitle}"`);
                } else if (best >= 0.34) {
                    buckets.mid++;
                    if (examples.length < 40) examples.push(`  ${best.toFixed(2)}  ${day} "${s.title}"\n         vs ${bestDay} "${bestTitle}"`);
                } else if (best > 0) buckets.low++;
                else buckets.none++;
            }
            prior.push(...todays);
        }

        const total = Object.values(buckets).reduce((a, b) => a + b, 0);
        console.log('\n═══ CROSS-DAY TITLE SIMILARITY (real data) ═══');
        console.log(`identical token set (what storyKey catches today): ${buckets.exact}`);
        console.log(`>= 0.50 overlap  (near-certain same story, MISSED):  ${buckets.high}`);
        console.log(`0.34-0.50        (likely related, missed):          ${buckets.mid}`);
        console.log(`< 0.34           (weak):                            ${buckets.low}`);
        console.log(`no overlap at all:                                  ${buckets.none}`);
        console.log(`total stories: ${total}`);
        console.log('\n─── the near-misses storyKey does NOT catch ───');
        console.log(examples.slice(0, 30).join('\n'));
        expect(total).toBeGreaterThan(50);
    });
});
