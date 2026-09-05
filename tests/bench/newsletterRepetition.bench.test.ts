/**
 * BENCHMARK against the user's real vault, not a fixture.
 *
 * Two questions, both answered from data that already exists:
 *   1. How bad is the repetition, really? Measures how many stories in each
 *      day's brief also appeared in an earlier day's brief.
 *   2. Would the shipped classifier have caught them? Runs the real
 *      `selectRecall` over the real ledger for each day and reports what it
 *      would have told the model.
 *
 * Free and deterministic — no LLM calls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseBriefStories } from '../../src/services/newsletter/newsletterStoryLedger';
import { selectRecall } from '../../src/services/newsletter/newsletterRecall';
import { isRegionRelevant } from '../../src/services/newsletter/homeRegionAliases';
import {
    MEMORY_SCHEMA_VERSION,
    type ConsumptionState,
    type StoryLedger,
} from '../../src/services/newsletter/newsletterMemoryTypes';

const VAULT = 'C:/obsidian/Second Brain';
const INBOX = `${VAULT}/0 Inbox/Newsletter Inbox`;
const DATA = `${VAULT}/.obsidian/plugins/ai-organiser/data.json`;

function briefFor(day: string): string | null {
    const p = `${INBOX}/Digest — ${day}.md`;
    if (!existsSync(p)) return null;
    const m = /<!--\s*DAILY_BRIEF_START\s*-->([\s\S]*?)<!--\s*DAILY_BRIEF_END\s*-->/
        .exec(readFileSync(p, 'utf8'));
    return m ? m[1] : null;
}

function days(): string[] {
    const d = JSON.parse(readFileSync(DATA, 'utf8'));
    return Object.keys(d['newsletter-story-ledger']?.buckets ?? {}).sort();
}

describe('newsletter repetition, measured on real briefs', () => {
    it('quantifies how often a story is retold on a later day', () => {
        const all = days();
        const seenBefore = new Map<string, string>(); // key -> first day it appeared
        const rows: string[] = [];
        let totalStories = 0;
        let totalRepeats = 0;

        for (const day of all) {
            const brief = briefFor(day);
            if (!brief) continue;
            const r = parseBriefStories(brief);
            if (r.kind !== 'parsed') { rows.push(`${day}: UNPARSEABLE`); continue; }

            const repeats: string[] = [];
            for (const s of r.stories) {
                totalStories++;
                const first = seenBefore.get(s.key);
                if (first) { repeats.push(`${s.title}   (first told ${first})`); totalRepeats++; }
                else seenBefore.set(s.key, day);
            }
            rows.push(`\n${day}: ${r.stories.length} stories, ${repeats.length} already told before`);
            for (const rep of repeats) rows.push('      REPEAT  ' + rep);
        }

        console.log('\n═══ REPETITION IN THE REAL BRIEFS ═══');
        console.log(rows.join('\n'));
        console.log(`\nTOTAL: ${totalRepeats} of ${totalStories} stories were retold on a later day` +
            ` (${((totalRepeats / Math.max(1, totalStories)) * 100).toFixed(1)}%)`);
        expect(totalStories).toBeGreaterThan(50);
    });

    it('shows what selectRecall would have told the model each day', () => {
        const d = JSON.parse(readFileSync(DATA, 'utf8'));
        const ledger: StoryLedger = d['newsletter-story-ledger'];
        const all = days();

        console.log('\n═══ WHAT THE MODEL WOULD HAVE BEEN TOLD ═══');
        for (const day of all.slice(1)) {
            // Assume the reader listened to every previous day (revision 1).
            const consumed: ConsumptionState = { version: MEMORY_SCHEMA_VERSION, consumed: {} };
            for (const prior of all.filter(x => x < day)) {
                consumed.consumed[prior] = {
                    firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1,
                };
            }
            const sel = selectRecall(ledger, consumed, day);
            console.log(`${day}:  heard ${sel.heard.length}   continuing ${sel.continuing.length}   unheard ${sel.unheard.length}`);
        }

        // The last day, in detail — this is the prompt the model would receive.
        const day = all[all.length - 1];
        const consumed: ConsumptionState = { version: MEMORY_SCHEMA_VERSION, consumed: {} };
        for (const prior of all.filter(x => x < day)) {
            consumed.consumed[prior] = { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 };
        }
        const sel = selectRecall(ledger, consumed, day);
        console.log(`\n─── detail for ${day} ───`);
        console.log(`heard (omit unless new): ${sel.heard.length}`);
        for (const s of sel.heard.slice(0, 12)) console.log('   ' + s.bucketDate + '  ' + s.title);
        console.log(`unheard: ${sel.unheard.length}`);
        for (const s of sel.unheard.slice(0, 6)) console.log('   ' + s.bucketDate + '  ' + s.title);
        expect(sel.heard.length + sel.unheard.length).toBeGreaterThan(0);
    });

    it('counts how much of the real content is home-region', () => {
        const d = JSON.parse(readFileSync(DATA, 'utf8'));
        const region: string = d.newsletterHomeRegion ?? '';
        const ledger: StoryLedger = d['newsletter-story-ledger'];
        const hits: string[] = [];
        let total = 0;
        for (const [day, b] of Object.entries(ledger.buckets)) {
            for (const s of b.stories) {
                total++;
                if (isRegionRelevant({ subject: s.title, triageText: s.gist }, region)) {
                    hits.push(`${day}  ${s.title}`);
                }
            }
        }
        console.log('\n═══ HOME-REGION COVERAGE ═══');
        console.log(`region: ${region}`);
        console.log(`${hits.length} of ${total} stories are home-region:`);
        for (const h of hits) console.log('   ' + h);
        expect(total).toBeGreaterThan(50);
    });
});
