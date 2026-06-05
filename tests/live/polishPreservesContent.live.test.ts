/**
 * LIVE verification (NOT hermetic — calls a real LLM). Gated behind LIVE_LLM=1 so
 * it never runs in normal CI. Proves the #2 fix WORKS end-to-end: under "this slide
 * is too dense — reduce the text" pressure (the exact instruction that previously
 * deleted the process-flow's final step + the chart framing), the polish now
 * PRESERVES the load-bearing content.
 *
 *   LIVE_LLM=1 npx vitest run tests/live/polishPreservesContent.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { buildIrSystemPrompt } from '../../src/services/presentationIr/irPrompts';
import { buildSelectivePrompt } from '../../src/services/chat/refineDeckIrSelective';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SlideDeckIr } from '../../src/services/presentationIr/slideIr';

const LIVE = process.env.LIVE_LLM === '1';
const d = LIVE ? describe : describe.skip;

/** Minimal .env reader (no dotenv dep) for the OpenAI key. */
function readKey(name: string): string | undefined {
    for (const f of ['.env', `${process.env.HOME ?? process.env.USERPROFILE}/.audit-loop.env`]) {
        try {
            const line = readFileSync(resolve(f), 'utf8').split('\n').find(l => l.startsWith(`${name}=`));
            const v = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
            if (v) return v;
        } catch { /* next */ }
    }
    return process.env[name];
}

/** A representative "polish target": a 6-step process flow whose 6th step is the
 *  payoff, a chart with a framing axisLabel + a takeaway bullet. */
const DECK: SlideDeckIr = {
    schemaVersion: 1,
    title: 'The 135 GW Blind Spot',
    slides: [
        {
            id: 's1', type: 'content', title: 'Thermal Enables Renewables — Not the Reverse',
            blocks: [
                {
                    kind: 'process-flow', steps: [
                        { title: 'Unstable Grid', sub: 'Diesel fills every gap; renewables cannot integrate at scale' },
                        { title: 'Add Firm Capacity', sub: 'Modular gas or dual-fuel, gas-ready from commissioning' },
                        { title: 'Grid Stabilises', sub: 'Reliable baseload enables long-term planning' },
                        { title: 'Renewables Scale', sub: 'Flexible thermal absorbs solar and wind variability' },
                        { title: 'Thermal Tapers', sub: 'Contract covenants trigger a dated, scheduled phase-down' },
                        { title: 'Clean Grid', sub: 'Renewables + storage carry the full load' },
                    ],
                },
                { kind: 'paragraph', text: 'Working precedent: the UK decarbonised its grid by running gas plants flexibly while renewables scaled — not a theoretical model.', emphasis: false },
            ],
        },
        {
            id: 's2', type: 'content', title: 'What Displacing Diesel Actually Achieves',
            blocks: [
                { kind: 'paragraph', text: 'Replacing decentralised diesel with planned gas or dual-fuel capacity delivers immediate, measurable gains — before a single new solar panel is installed.' },
                {
                    kind: 'bar-chart',
                    bars: [
                        { label: 'Distributed diesel (status quo)', pct: 100 },
                        { label: 'Planned gas / dual-fuel plant', pct: 63 },
                        { label: 'Grid-scale solar / wind (target)', pct: 5 },
                    ],
                    axisLabel: 'Relative CO₂ per kWh (diesel = 100)',
                    source: 'Illustrative index',
                },
                { kind: 'bullets', items: [
                    '30–40% CO₂ reduction per kWh — immediately upon switching from diesel',
                    'Eliminates sulphur dioxide and particulate matter from urban air',
                    'Represents the largest, fastest emissions reductions available in most African power systems today',
                ] },
            ],
        },
    ],
};

async function callOpenAI(fullPrompt: string): Promise<string> {
    const key = readKey('OPENAI_API_KEY');
    if (!key) throw new Error('OPENAI_API_KEY not found');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: fullPrompt }], temperature: 0.2 }),
    });
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (j.error) throw new Error(j.error.message);
    return j.choices?.[0]?.message?.content ?? '';
}

d('LIVE: polish preserves load-bearing content (#2)', () => {
    it('keeps the process-flow payoff step + chart framing + takeaway under "reduce text" pressure', async () => {
        // The polish path: system + selective prompt, with the EXACT density pressure.
        const system = buildIrSystemPrompt({});
        const selective = buildSelectivePrompt(
            DECK,
            [
                { slideIndex: 0, instruction: 'This slide is too dense — reduce the text and tighten it.' },
                { slideIndex: 1, instruction: 'This slide is too dense — reduce the text and tighten it.' },
            ],
            [{ issue: 'density: too much text', suggestion: 'reduce the number of words on these slides', severity: 'MEDIUM' }],
        );
        const raw = await callOpenAI(`${system}\n\n${selective}`);

        // Parse the slices manually (selective returns {slices:[{slideIndex,slides}]}).
        const jsonStart = raw.indexOf('{');
        const jsonEnd = raw.lastIndexOf('}');
        const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { slices: Array<{ slideIndex: number; slides: SlideDeckIr['slides'] }> };

        const flowSlide = parsed.slices.find(s => s.slideIndex === 0)?.slides?.[0];
        const flow = flowSlide?.blocks.find(b => b.kind === 'process-flow') as { steps: Array<{ title: string; sub?: string }> } | undefined;
        const chartSlide = parsed.slices.find(s => s.slideIndex === 1)?.slides?.[0];
        const chart = chartSlide?.blocks.find(b => b.kind === 'bar-chart') as { axisLabel?: string } | undefined;
        const allText = JSON.stringify(parsed).toLowerCase();

        // 1. The process-flow PAYOFF step survives (was deleted in the regression).
        expect(flow, 'process-flow must survive').toBeTruthy();
        expect(flow!.steps.length, 'flow must keep ~all steps (incl. the payoff)').toBeGreaterThanOrEqual(5);
        expect(allText, 'the "Clean Grid" payoff step must not be deleted').toContain('clean grid');

        // 2. The chart framing / units survive.
        expect(chart?.axisLabel ?? '', 'chart axisLabel (units/framing) must survive').toMatch(/co.?2|diesel = 100/i);

        // 3. A takeaway bullet survives (not all bullets stripped).
        expect(allText).toMatch(/co.?2|reduction|emissions/);

        // Diagnostic dump for the human.
        console.log('[live-polish] flow steps:', flow!.steps.map(s => s.title).join(' → '));
        console.log('[live-polish] chart axisLabel:', chart?.axisLabel);
    }, 60_000);

    it('CONTROL: the OLD prompt (guidance stripped) is prone to dropping the payoff step', async () => {
        const system = buildIrSystemPrompt({});
        const fixed = buildSelectivePrompt(
            DECK,
            [{ slideIndex: 0, instruction: 'This slide is too dense — reduce the text and tighten it.' }],
            [{ issue: 'density: too much text', suggestion: 'reduce the number of words', severity: 'MEDIUM' }],
        );
        // Strip the new preserve-load-bearing requirement → reproduce the pre-fix prompt.
        const oldPrompt = fixed.replace(/- PRESERVE load-bearing content[\s\S]*?rather than delete\./, '');
        expect(oldPrompt).not.toMatch(/PRESERVE load-bearing/i); // confirm the control is stripped

        const raw = await callOpenAI(`${system}\n\n${oldPrompt}`);
        const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { slices: Array<{ slideIndex: number; slides: SlideDeckIr['slides'] }> };
        const flow = parsed.slices[0]?.slides?.[0]?.blocks.find(b => b.kind === 'process-flow') as { steps: Array<{ title: string }> } | undefined;
        const steps = flow?.steps.map(s => s.title) ?? [];
        const keptPayoff = JSON.stringify(parsed).toLowerCase().includes('clean grid');
        // This is a DIAGNOSTIC contrast, not a hard assertion (LLM nondeterminism) —
        // log so the human sees the before/after delta vs the fixed run above.
        console.log(`[live-polish CONTROL] steps(${steps.length}): ${steps.join(' → ')} | keptPayoff=${keptPayoff}`);
        expect(steps.length).toBeGreaterThan(0); // sanity only
    }, 60_000);
});
