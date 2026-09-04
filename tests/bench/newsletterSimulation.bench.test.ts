/**
 * SIMULATION on the user's real data, with the real LLM.
 *
 * Scenario, as asked: the reader last listened on 2026-09-01. Regenerate the
 * briefs for 09-02 and 09-03 with story memory switched on, and compare them
 * against the briefs those days actually produced (which had no memory).
 *
 * Everything is real: the sources are the actual newsletter notes, the prompt is
 * the shipped builder, and the synthesis runs through the user's own configured
 * model. Only the memory state is constructed, and it is constructed to match
 * exactly what the feature would have held on those mornings.
 *
 * Writes prompts and outputs to sessions/newsletter-sim/ for inspection.
 *
 *   RUN:  NL_SIM=1 npx vitest run tests/bench/newsletterSimulation.bench.test.ts
 *
 * Skipped unless NL_SIM is set — it costs real LLM calls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    buildDailyBriefPrompt,
    insertBriefContent,
    type BriefSource,
} from '../../src/services/prompts/newsletterPrompts';
import { extractTriageFromNote, extractFrontmatterField } from '../../src/services/newsletter/newsletterService';
import { parseBriefStories, mergeBucketRevision, storyKey } from '../../src/services/newsletter/newsletterStoryLedger';
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
const OUT = 'scripts/persona-harness/sessions/newsletter-sim';

const LAST_LISTENED = '2026-09-01';
const REPLAY = ['2026-09-02', '2026-09-03'];

/** Real BriefSource[] for a day, built the way collectDayNewsletters builds them. */
function sourcesFor(day: string, region: string): BriefSource[] {
    const dir = `${INBOX}/${day}`;
    if (!existsSync(dir)) return [];
    const out: BriefSource[] = [];
    for (const f of readdirSync(dir).filter(n => n.endsWith('.md'))) {
        const c = readFileSync(join(dir, f), 'utf8');
        const senderName = extractFrontmatterField(c, 'sender_name') ?? f.replace(/\.md$/, '');
        const subject = /^#\s+(.+)$/m.exec(c)?.[1]?.trim();
        const triageText = extractTriageFromNote(c);
        if (!triageText.trim()) continue;
        out.push({
            sourceDisplayName: senderName,
            triageText,
            senderName,
            subject,
            local: isRegionRelevant({ senderName, subject, triageText }, region),
        });
    }
    return out;
}

function briefBlock(day: string): string | null {
    const p = `${INBOX}/Digest — ${day}.md`;
    if (!existsSync(p)) return null;
    const m = /<!--\s*DAILY_BRIEF_START\s*-->([\s\S]*?)<!--\s*DAILY_BRIEF_END\s*-->/.exec(readFileSync(p, 'utf8'));
    return m ? m[1].trim() : null;
}

/** Ledger holding every day strictly before `upTo`, as the feature would have. */
function ledgerBefore(upTo: string): StoryLedger {
    const led: StoryLedger = { version: MEMORY_SCHEMA_VERSION, buckets: {} };
    for (const name of readdirSync(INBOX).filter(n => /^Digest — \d{4}-\d{2}-\d{2}\.md$/.test(n))) {
        const day = /(\d{4}-\d{2}-\d{2})/.exec(name)![1];
        if (day >= upTo) continue;
        const brief = briefBlock(day);
        if (!brief) continue;
        const r = parseBriefStories(brief);
        if (r.kind !== 'parsed') continue;
        led.buckets[day] = {
            revision: 1, updatedAt: 0, audio: {},
            stories: mergeBucketRevision([], r.stories, 1),
        };
    }
    return led;
}

function consumedThrough(day: string, ledger: StoryLedger): ConsumptionState {
    const st: ConsumptionState = { version: MEMORY_SCHEMA_VERSION, consumed: {} };
    for (const d of Object.keys(ledger.buckets)) {
        if (d <= day) {
            st.consumed[d] = { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 };
        }
    }
    return st;
}

const RUN = !!process.env.NL_SIM;

describe.skipIf(!RUN)('brief simulation with memory, real data + real model', () => {
    it('replays 09-02 and 09-03 as if the reader last listened on 09-01', async () => {
        mkdirSync(OUT, { recursive: true });
        const settings = JSON.parse(readFileSync(DATA, 'utf8'));
        const region: string = settings.newsletterHomeRegion ?? '';

        // Memory as it would have stood on the morning of the first replay day.
        let ledger = ledgerBefore(REPLAY[0]);

        for (const day of REPLAY) {
            const sources = sourcesFor(day, region);
            const consumption = consumedThrough(LAST_LISTENED, ledger);
            const recall = selectRecall(ledger, consumption, day);

            const prompt = insertBriefContent(
                buildDailyBriefPrompt({ language: 'English', recall, homeRegion: region }),
                sources,
                60_000,
            ).filled;
            writeFileSync(join(OUT, `prompt-${day}.txt`), prompt);

            console.log(`\n═══ ${day} ═══`);
            console.log(`sources: ${sources.length}   local: ${sources.filter(s => s.local).length}`);
            console.log(`recall → heard ${recall.heard.length}, continuing ${recall.continuing.length}, unheard ${recall.unheard.length}`);
            console.log(`prompt: ${prompt.length} chars`);

            const brief = await synthesise(prompt);
            writeFileSync(join(OUT, `brief-with-memory-${day}.md`), brief);

            const actual = briefBlock(day) ?? '';
            writeFileSync(join(OUT, `brief-actual-${day}.md`), actual);

            const withMem = parseBriefStories(brief);
            const without = parseBriefStories(actual);
            console.log(`\nACTUAL (no memory): ${without.kind === 'parsed' ? without.stories.length : '?'} stories, ${actual.length} chars`);
            console.log(`WITH MEMORY:        ${withMem.kind === 'parsed' ? withMem.stories.length : '?'} stories, ${brief.length} chars`);
            console.log('\n--- brief WITH memory ---\n' + brief);

            // Feed this day forward, so 09-03 remembers 09-02.
            if (withMem.kind === 'parsed') {
                ledger = {
                    ...ledger,
                    buckets: {
                        ...ledger.buckets,
                        [day]: { revision: 1, updatedAt: 0, audio: {}, stories: mergeBucketRevision([], withMem.stories, 1) },
                    },
                };
            }
        }
        expect(true).toBe(true);
    }, 600_000);
});

/** Send a prompt through the plugin's own configured LLM, in the running Obsidian. */
async function synthesise(prompt: string): Promise<string> {
    const { launchOrAttach, ensureVaultOpen, waitForPluginReady } = await import(
        '../../../../scripts/persona-harness/driver.mjs' as string
    );
    const { browser, page } = await launchOrAttach();
    await ensureVaultOpen(browser, page, 'Second Brain');
    await waitForPluginReady(page);
    const res = await page.evaluate(
        `(async (p) => {
            const svc = window.app.plugins.plugins['ai-organiser'].llmService;
            const r = await svc.summarizeText(p, { maxTokens: 16000, disableThinking: true });
            return r && r.success ? r.content : 'LLM FAILED: ' + JSON.stringify(r).slice(0, 400);
        })(${JSON.stringify(prompt)})`,
    );
    return String(res);
}
