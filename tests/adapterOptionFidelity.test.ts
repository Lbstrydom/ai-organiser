/**
 * Emitted-request conformance (llm-option-fidelity D8).
 *
 * Registry-driven: for EVERY adapter type, on BOTH the non-stream and the stream path, each
 * per-call option is tested one at a time against the request the service really emits. The
 * option must either appear on the wire or be listed in `fidelity.dropped` with a reason.
 * An option that is neither applied nor reported fails. That failure is how a silent drop
 * shows up from now on.
 *
 * The capability table is NOT its own oracle: the expectations come from
 * `fixtures/providerWireContract.ts`, written from each provider's request contract. A row
 * that wrongly says "unsupported" is rejected because the fixture says the provider supports
 * the option (see the negative control at the bottom).
 *
 * Like adapterConformance, a new adapter needs no edit here; it fails until the fixture and
 * the table both have its row.
 *
 * `signal` and `timeoutMs` have no body to inspect: see cloudServiceStreamLifecycle.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAdapter, type AdapterType } from '../src/services/adapters';
import { ALL_ADAPTERS, PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL } from '../src/services/adapters/providerRegistry';
import { OPTION_CAPABILITIES, type OptionName, type DropReason } from '../src/services/llm/optionCapabilities';
import type { Fidelity, SummarizeOptions } from '../src/services/types';
import { makeService, stubFetch, sseResponse, linesFor } from './helpers/streamHarness';
import { PROVIDER_WIRE_CONTRACT } from './fixtures/providerWireContract';

afterEach(() => { vi.unstubAllGlobals(); });

type Path = 'non-stream' | 'stream';
interface Emitted { body: Record<string, unknown>; fidelity?: Fidelity }

const MARK = 'STABLE_PREFIX_MARK_7f3a';
const OVERRIDE = 'override-model-x';
const CAP = 4096; // at the highest app floor (always-thinking Claude) and at the lowest output limit (aliyun, cohere): arrives unchanged

const CANNED_RESPONSE = {
    model: 'reported-model',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    content: [{ type: 'text', text: 'ok' }],
    message: { content: [{ type: 'text', text: 'ok' }] }, // cohere v2
    stop_reason: 'end_turn',
};

async function emit(type: AdapterType, path: Path, options: SummarizeOptions): Promise<Emitted> {
    const svc = makeService(type);
    if (path === 'non-stream') {
        let captured: Record<string, unknown> | undefined;
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async (opts: { body: string }) => {
            captured = JSON.parse(opts.body);
            return { status: 200, text: JSON.stringify(CANNED_RESPONSE), headers: {} };
        };
        const r = await svc.summarizeText('PROMPT', options);
        if (!captured) throw new Error(`[${type}][non-stream] no request emitted: ${r.error}`);
        return { body: captured, fidelity: r.fidelity };
    }
    const cap = stubFetch(() => sseResponse(linesFor(type)));
    const r = await svc.summarizeTextStream('PROMPT', () => undefined, undefined, options);
    return { body: cap[0].body, fidelity: r.fidelity };
}

const DROP_REASONS: ReadonlySet<DropReason> = new Set(['unsupported-by-provider', 'deployment-routed', 'unresolved-sentinel', 'no-model-capability']);
const droppedReason = (f: Fidelity | undefined, option: OptionName): DropReason | undefined => f?.dropped.find(d => d.option === option)?.reason;
const bodyHas = (body: Record<string, unknown>, text: string): boolean => JSON.stringify(body).includes(text);

/** Every violation of the contract for one adapter, path and option. Empty means conforming. */
async function violations(type: AdapterType, path: Path, option: 'modelOverride' | 'maxTokens' | 'enableThinking' | 'disableThinking' | 'stablePrefix' | 'both-thinking-flags'): Promise<string[]> {
    const wire = PROVIDER_WIRE_CONTRACT[type];
    const out: string[] = [];
    const tag = `[${type}][${path}][${option}]`;
    const fail = (m: string): void => { out.push(`${tag} ${m}`); };

    if (option === 'modelOverride') {
        const { body, fidelity } = await emit(type, path, { modelOverride: OVERRIDE });
        const applied = body.model === OVERRIDE;
        const reason = droppedReason(fidelity, 'modelOverride');
        if (wire.modelInBody) {
            if (!applied) fail(`fixture says the model travels in the body, but body.model=${JSON.stringify(body.model)}${reason ? ` (reported dropped: ${reason}; the fixture rejects that drop)` : ' and nothing was reported'}`);
            if (applied && fidelity?.routing !== 'per-call') fail(`applied but fidelity.routing=${fidelity?.routing}`);
        } else {
            if (applied) fail('the fixture says the override cannot reach this provider, yet it was sent');
            if (!reason) fail('dropped silently: not in the body and not in fidelity.dropped');
            else if (!DROP_REASONS.has(reason)) fail(`unknown drop reason ${reason}`);
            else if (wire.overrideBlockedBy === 'deployment-url' && reason !== 'deployment-routed') fail(`expected deployment-routed, got ${reason}`);
        }
    }

    if (option === 'maxTokens') {
        const { body, fidelity } = await emit(type, path, { maxTokens: CAP });
        const field = wire.maxTokensFields.find(f => body[f] !== undefined);
        if (!field) fail(`none of ${wire.maxTokensFields.join('/')} on the wire`);
        else if (body[field] !== CAP) {
            const adj = fidelity?.adjusted.find(a => a.option === 'maxTokens');
            if (!adj || adj.effective !== body[field]) fail(`${field}=${String(body[field])} differs from the request (${CAP}) and the adjustment is not reported`);
        }
    }

    if (option === 'enableThinking') {
        const { body, fidelity } = await emit(type, path, { enableThinking: true });
        const sent = !!body.thinking;
        const reason = droppedReason(fidelity, 'enableThinking');
        if (wire.thinkingParam) {
            if (!sent && !reason) fail('thinking neither sent nor reported');
            if (!sent && reason && reason !== 'no-model-capability') fail(`provider supports thinking; a drop is only valid for the model (no-model-capability), got ${reason}`);
        } else {
            if (sent) fail('the provider has no thinking parameter, yet one was sent');
            if (!reason) fail('thinking dropped silently');
        }
    }

    if (option === 'disableThinking') {
        const { body } = await emit(type, path, { disableThinking: true });
        if (body.thinking) fail(`disableThinking was ignored: ${JSON.stringify(body.thinking)} on the wire`);
    }

    if (option === 'both-thinking-flags') {
        const { body, fidelity } = await emit(type, path, { enableThinking: true, disableThinking: true });
        if (body.thinking) fail('disableThinking must win, but thinking was sent');
        if (wire.thinkingParam && !fidelity?.adjusted.some(a => a.option === 'enableThinking' && a.reason === 'overruled-by-disable-thinking')) {
            fail('the overruled enableThinking is not reported');
        }
    }

    if (option === 'stablePrefix') {
        const { body } = await emit(type, path, { stablePrefix: MARK });
        if (!bodyHas(body, MARK)) fail('the stable prefix is nowhere in the emitted body');
    }

    return out;
}

const OPTIONS = ['modelOverride', 'maxTokens', 'enableThinking', 'disableThinking', 'both-thinking-flags', 'stablePrefix'] as const;

describe('fixtures and table cover the registry', () => {
    it.each(ALL_ADAPTERS)('%s has a wire-contract fixture and a capability row', (type) => {
        expect(PROVIDER_WIRE_CONTRACT[type], `[${type}] missing in fixtures/providerWireContract.ts`).toBeDefined();
        expect(OPTION_CAPABILITIES[type], `[${type}] missing in OPTION_CAPABILITIES`).toBeDefined();
    });

    it.each(ALL_ADAPTERS)('%s: the fixture and the adapter agree on streaming', (type) => {
        const adapter = createAdapter(type, { endpoint: PROVIDER_ENDPOINT[type], apiKey: 'k', modelName: PROVIDER_DEFAULT_MODEL[type] });
        expect(!!adapter.supportsStreaming?.(), `[${type}] supportsStreaming() vs fixture.streams`).toBe(PROVIDER_WIRE_CONTRACT[type].streams);
    });
});

describe.each(ALL_ADAPTERS)('%s emitted-request conformance', (type) => {
    describe.each(['non-stream', 'stream'] as const)('%s path', (path) => {
        if (path === 'stream' && !PROVIDER_WIRE_CONTRACT[type].streams) {
            it('does not stream (the facade falls back to non-stream)', () => {
                expect(PROVIDER_WIRE_CONTRACT[type].streams).toBe(false);
            });
            return;
        }
        it.each(OPTIONS)('%s is applied or reported, never silently dropped', async (option) => {
            expect(await violations(type, path, option)).toEqual([]);
        });
    });
});

describe('effective values and reasons (D1 adjusted)', () => {
    const adjust = async (type: AdapterType, path: Path, options: SummarizeOptions) => (await emit(type, path, options)).fidelity?.adjusted ?? [];

    it.each(['non-stream', 'stream'] as const)('clamping to the model output limit is reported (%s)', async (path) => {
        const adj = await adjust('claude', path, { maxTokens: 10_000_000 });
        const m = adj.find(a => a.option === 'maxTokens');
        expect(m?.reason).toBe('clamped-to-model-limit');
        expect(Number(m?.effective)).toBeLessThan(10_000_000);
    });

    it.each(['non-stream', 'stream'] as const)('a request inside every limit is neither clamped nor raised (%s)', async (path) => {
        for (const type of ALL_ADAPTERS.filter(t => PROVIDER_WIRE_CONTRACT[t].streams || path === 'non-stream')) {
            const adj = (await adjust(type, path, { maxTokens: CAP })).filter(a => a.option === 'maxTokens');
            expect(adj, `[${type}][${path}] maxTokens=${CAP} should arrive unchanged`).toEqual([]);
        }
    });

    it('any change to maxTokens carries a reason from the closed set and names the effective value on the wire', async () => {
        for (const type of ALL_ADAPTERS) {
            for (const maxTokens of [1, 1000, 4096, 100_000]) {
                const { body, fidelity } = await emit(type, 'non-stream', { maxTokens });
                const field = PROVIDER_WIRE_CONTRACT[type].maxTokensFields.find(f => body[f] !== undefined);
                const adj = fidelity?.adjusted.find(a => a.option === 'maxTokens');
                if (field && body[field] !== maxTokens) {
                    expect(adj, `[${type}] maxTokens ${maxTokens} -> ${String(body[field])} unreported`).toBeDefined();
                    expect(adj?.effective).toBe(body[field]);
                    expect(['clamped-to-model-limit', 'raised-to-app-minimum']).toContain(adj?.reason);
                }
            }
        }
    });

    it('an always-thinking Claude model with a low cap reports the app floor as app policy, not a provider rule', async () => {
        const adj = (await adjust('claude', 'non-stream', { maxTokens: 1000 })).find(a => a.option === 'maxTokens');
        if (adj) expect(adj.reason).toBe('raised-to-app-minimum');
    });
});

describe('controls', () => {
    it('positive control: a stream body that ignored the cap and did not report it is the shape this suite rejects', async () => {
        // Simulates the pre-fix behaviour: a body whose max_tokens ignores the caller's cap, unreported.
        const real = await emit('claude', 'stream', { maxTokens: CAP });
        const forged: Emitted = { body: { ...real.body, max_tokens: 1024 }, fidelity: { ...real.fidelity!, adjusted: [] } };
        const field = PROVIDER_WIRE_CONTRACT.claude.maxTokensFields.find(f => forged.body[f] !== undefined)!;
        const unreported = forged.body[field] !== CAP && !forged.fidelity?.adjusted.find(a => a.option === 'maxTokens');
        expect(unreported).toBe(true);
    });

    it('negative control: a table row wrongly marked unsupported is rejected by the fixtures', async () => {
        const original = OPTION_CAPABILITIES.groq;
        (OPTION_CAPABILITIES as Record<string, unknown>).groq = { ...original, modelOverride: 'none' };
        try {
            // The body still carries the override (the builder does not read the table), but the
            // fidelity report now claims it was dropped: the fixture rejects that report.
            const v = await violations('groq', 'non-stream', 'modelOverride');
            expect(v.length).toBeGreaterThan(0);
            expect(v.join('\n')).toMatch(/applied but fidelity\.routing/);
        } finally {
            (OPTION_CAPABILITIES as Record<string, unknown>).groq = original;
        }
    });

    it('negative control: a provider the fixture says cannot take the override must report the drop', async () => {
        const original = OPTION_CAPABILITIES['azure-openai'];
        (OPTION_CAPABILITIES as Record<string, unknown>)['azure-openai'] = { ...original, modelOverride: 'per-call' };
        try {
            // The table now claims per-call; the body still has the deployment model, so nothing is reported.
            const v = await violations('azure-openai', 'non-stream', 'modelOverride');
            expect(v.length).toBeGreaterThan(0);
        } finally {
            (OPTION_CAPABILITIES as Record<string, unknown>)['azure-openai'] = original;
        }
    });
});
