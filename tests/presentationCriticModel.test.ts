/**
 * The critic never silently judges with the generator's model
 * (llm-option-fidelity D3): the routing matrix, the identity comparator, the
 * generator-to-judge handoff, and the single visible notice per run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let forcedRole: unknown;
vi.mock('../src/services/presentationIr/presentationModelResolver', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    const { ok } = await import('../src/core/result');
    return {
        ...actual,
        resolvePresentationRole: (role: unknown, ctx: unknown) =>
            forcedRole ? ok(forcedRole) : (actual.resolvePresentationRole as (...a: unknown[]) => unknown)(role, ctx),
    };
});
let mockProfile: { provider: string; model: string };
vi.mock('../src/services/providerProfile', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    return { ...actual, resolveProviderProfile: vi.fn(async () => mockProfile) };
});

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { CloudLLMService } from '../src/services/cloudService';
import { independenceFor } from '../src/services/presentationIr/presentationModelResolver';
import { buildStoryboardJudge } from '../src/services/chat/consultantCriticService';
import { runStoryboardStage } from '../src/services/chat/consultantStoryboardPipeline';
import { GUIDANCE_CODES, describeError, formatGuidance } from '../src/core/friendlyErrors';
import { mockNotices, clearMockNotices } from './mocks/obsidian';
import { en } from '../src/i18n/en';
import type { Fidelity } from '../src/services/types';
import type { ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';

function fid(p: Partial<Fidelity> & Pick<Fidelity, 'provider'>): Fidelity {
    return { requestedModel: 'm', routing: 'service-config', dropped: [], adjusted: [], ...p };
}

// ── identity comparator (D1 policy) ──────────────────────────────────────────

describe('independenceFor', () => {
    it('same: equal reported models from the same provider', () => {
        const a = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6-20260101' });
        const b = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6-20260101' });
        expect(independenceFor(a, b)).toBe('same');
    });

    it('same: a per-call requested model counts as concrete', () => {
        const a = fid({ provider: 'gemini', routing: 'per-call', requestedModel: 'gemini-x' });
        const b = fid({ provider: 'gemini', reportedModel: 'gemini-x' });
        expect(independenceFor(a, b)).toBe('same');
    });

    it('different: unequal concrete models from the same provider', () => {
        const a = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        const b = fid({ provider: 'claude', reportedModel: 'claude-opus-4-6' });
        expect(independenceFor(a, b)).toBe('different');
    });

    it('different: concrete models from providers of different families', () => {
        const a = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        const b = fid({ provider: 'gemini', reportedModel: 'gemini-2.5-pro' });
        expect(independenceFor(a, b)).toBe('different');
    });

    it('unknown: aliases, service-config names and deployment names are routing evidence only', () => {
        const a = fid({ provider: 'claude', routing: 'service-config', requestedModel: 'latest-sonnet' });
        const b = fid({ provider: 'claude', routing: 'service-config', requestedModel: 'latest-opus' });
        expect(independenceFor(a, b)).toBe('unknown');
        const d1 = fid({ provider: 'azure-openai', routing: 'deployment', requestedModel: 'dep-a' });
        const d2 = fid({ provider: 'azure-openai', routing: 'deployment', requestedModel: 'dep-b' });
        expect(independenceFor(d1, d2)).toBe('unknown');
    });

    it('unknown: equal strings from different providers never prove same', () => {
        const a = fid({ provider: 'openai', reportedModel: 'gpt-x' });
        const b = fid({ provider: 'openrouter', reportedModel: 'gpt-x' });
        expect(independenceFor(a, b)).toBe('unknown');
    });

    it('unknown: a missing reportedModel on one side', () => {
        const a = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        const b = fid({ provider: 'claude', routing: 'service-config', requestedModel: 'claude-sonnet-4-6' });
        expect(independenceFor(a, b)).toBe('unknown');
    });

    it('unknown: missing fidelity is never independent', () => {
        const a = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        expect(independenceFor(undefined, a)).toBe('unknown');
        expect(independenceFor(a, undefined)).toBe('unknown');
        expect(independenceFor(undefined, undefined)).toBe('unknown');
    });
});

// ── guidance code ────────────────────────────────────────────────────────────

describe('critic-model-unavailable guidance', () => {
    it('is registered with two-sentence English guidance', () => {
        expect(GUIDANCE_CODES).toContain('critic-model-unavailable');
        const g = describeError(en, 'critic-model-unavailable');
        expect(g).toBe(en.guidance['critic-model-unavailable']);
        expect(g.message.length).toBeGreaterThan(5);
        expect(g.nextStep.length).toBeGreaterThan(5);
    });
});

// ── routing matrix in the handler ────────────────────────────────────────────

type Row = {
    name: string;
    mainProvider: string;
    role: { provider: string; resolvedModel: string; modelOverride: string; crossProvider: boolean; family: string };
    expect: 'per-call' | 'specialist' | 'downgrade';
};

const rows: Row[] = [
    { name: 'gemini same-provider', mainProvider: 'gemini',
      role: { provider: 'gemini', resolvedModel: 'gemini-flash', modelOverride: 'gemini-flash', crossProvider: false, family: 'gemini' }, expect: 'per-call' },
    { name: 'claude same-provider', mainProvider: 'claude',
      role: { provider: 'claude', resolvedModel: 'claude-opus-4-6', modelOverride: 'claude-opus-4-6', crossProvider: false, family: 'claude' }, expect: 'per-call' },
    { name: 'openai same-provider', mainProvider: 'openai',
      role: { provider: 'openai', resolvedModel: 'gpt-x', modelOverride: 'gpt-x', crossProvider: false, family: 'openai' }, expect: 'per-call' },
    { name: 'bedrock same-provider', mainProvider: 'bedrock',
      role: { provider: 'bedrock', resolvedModel: 'anthropic.claude-opus', modelOverride: 'anthropic.claude-opus', crossProvider: false, family: 'claude' }, expect: 'specialist' },
    { name: 'azure-openai same-provider', mainProvider: 'azure-openai',
      role: { provider: 'azure-openai', resolvedModel: 'gpt-x', modelOverride: 'gpt-x', crossProvider: false, family: 'openai' }, expect: 'downgrade' },
    { name: 'local same-provider (Cluster A)', mainProvider: 'local',
      role: { provider: 'local', resolvedModel: 'llama', modelOverride: 'llama', crossProvider: false, family: 'other' }, expect: 'downgrade' },
    { name: 'local cross-provider', mainProvider: 'claude',
      role: { provider: 'local', resolvedModel: 'llama', modelOverride: '', crossProvider: true, family: 'other' }, expect: 'downgrade' },
    { name: 'gemini cross-provider', mainProvider: 'claude',
      role: { provider: 'gemini', resolvedModel: 'gemini-flash', modelOverride: '', crossProvider: true, family: 'gemini' }, expect: 'specialist' },
];

function makeRun(mainProvider: string) {
    const settings = {
        serviceType: mainProvider === 'local' ? 'local' : 'cloud',
        cloudServiceType: mainProvider,
        cloudApiKey: 'main-key',
        cloudEndpoint: 'https://example.test/v1',
        providerSettings: { gemini: { apiKey: 'g-key' } },
        presentationModelRoles: { storyboardGenerator: null, independentCritic: null },
        debugMode: false,
        summaryLanguage: 'en',
    };
    const llmCtx = { llmService: { summarizeText: vi.fn() }, settings };
    const ctx = { app: {}, plugin: { t: en, settings }, fullPlugin: { t: en, settings } };
    return { ctx, llmCtx, abort: new AbortController(), settings } as never as {
        ctx: unknown; llmCtx: { llmService: unknown }; abort: AbortController;
    };
}

type RoleRun = { context: { llmService: unknown }; modelOverride: string; downgrade?: { reason: string; ranOn: string } };
const resolveRoleRun = (h: PresentationModeHandler, r: unknown, role: string): Promise<RoleRun> =>
    (h as unknown as { resolveRoleRun(r: unknown, role: string): Promise<RoleRun> }).resolveRoleRun(r, role);

describe('resolveRoleRun — critic routing matrix', () => {
    beforeEach(() => { forcedRole = undefined; clearMockNotices(); });

    it.each(rows)('$name -> $expect', async (row) => {
        forcedRole = row.role;
        mockProfile = { provider: row.mainProvider, model: 'main-model' };
        const r = makeRun(row.mainProvider);
        const run = await resolveRoleRun(new PresentationModeHandler(), r, 'structural_critic');
        if (row.expect === 'per-call') {
            expect(run.context).toBe(r.llmCtx);
            expect(run.modelOverride).toBe(row.role.resolvedModel);
            expect(run.downgrade).toBeUndefined();
        } else if (row.expect === 'specialist') {
            expect(run.context).not.toBe(r.llmCtx);
            expect(run.context.llmService).toBeInstanceOf(CloudLLMService);
            expect(run.modelOverride).toBe('');
            expect(run.downgrade).toBeUndefined();
        } else {
            expect(run.context).toBe(r.llmCtx);
            expect(run.modelOverride).toBe('');
            expect(run.downgrade).toMatchObject({ ranOn: 'main' });
        }
    });

    it('a specialist built for bedrock carries the critic model in its own config', async () => {
        forcedRole = rows[3].role;
        mockProfile = { provider: 'bedrock', model: 'main-model' };
        const run = await resolveRoleRun(new PresentationModeHandler(), makeRun('bedrock'), 'structural_critic');
        const svc = run.context.llmService as unknown as { adapter: { config: { modelName: string } } };
        expect(svc.adapter.config.modelName).toBe('anthropic.claude-opus');
    });

    it('with no role chosen ("Main") there is no routing and no downgrade', async () => {
        forcedRole = undefined;
        mockProfile = { provider: 'azure-openai', model: 'gpt-x' };
        const r = makeRun('azure-openai');
        const run = await resolveRoleRun(new PresentationModeHandler(), r, 'structural_critic');
        expect(run.context).toBe(r.llmCtx);
        expect(run.downgrade).toBeUndefined();
    });

    it('the generator role keeps its existing behaviour (no downgrade is raised for it)', async () => {
        forcedRole = rows[4].role;
        mockProfile = { provider: 'azure-openai', model: 'main-model' };
        const run = await resolveRoleRun(new PresentationModeHandler(), makeRun('azure-openai'), 'storyboard_generator');
        expect(run.downgrade).toBeUndefined();
        expect(run.modelOverride).toBe('gpt-x');
    });
});

// ── notice precedence ────────────────────────────────────────────────────────

type Announce = (r: unknown, downgrade: { reason: string; ranOn: 'main' } | undefined, independence: string) => void;
const announce = (h: PresentationModeHandler, r: unknown, d: { reason: string; ranOn: 'main' } | undefined, i: string) =>
    (h as unknown as { announceCritic: Announce }).announceCritic(r, d, i);

describe('critic notice — one per run, with precedence', () => {
    const downgrade = { reason: 'deployment-routed', ranOn: 'main' as const };
    const guidanceText = formatGuidance(en.guidance['critic-model-unavailable']);
    beforeEach(() => clearMockNotices());

    it('no downgrade and different: no notice', () => {
        announce(new PresentationModeHandler(), makeRun('claude'), undefined, 'different');
        expect(mockNotices).toEqual([]);
    });

    it('no downgrade and same: independence notice only', () => {
        announce(new PresentationModeHandler(), makeRun('claude'), undefined, 'same');
        expect(mockNotices).toHaveLength(1);
        expect(mockNotices[0]).toBe(en.modals.unifiedChat.criticSameModel);
    });

    it('no downgrade and unknown: uncertainty notice, never an independence claim', () => {
        announce(new PresentationModeHandler(), makeRun('claude'), undefined, 'unknown');
        expect(mockNotices).toEqual([en.modals.unifiedChat.criticUnknownModel]);
    });

    it('downgrade and different: the downgrade text only', () => {
        announce(new PresentationModeHandler(), makeRun('claude'), downgrade, 'different');
        expect(mockNotices).toEqual([guidanceText]);
    });

    it('downgrade and same / unknown: downgrade text followed by the independence outcome', () => {
        announce(new PresentationModeHandler(), makeRun('claude'), downgrade, 'same');
        announce(new PresentationModeHandler(), makeRun('claude'), downgrade, 'unknown');
        expect(mockNotices[0]).toBe(`${guidanceText} ${en.modals.unifiedChat.criticSameModel}`);
        expect(mockNotices[1]).toBe(`${guidanceText} ${en.modals.unifiedChat.criticUnknownModel}`);
    });

    it('shows at most one notice per run', () => {
        const h = new PresentationModeHandler();
        const r = makeRun('claude');
        announce(h, r, downgrade, 'same');
        announce(h, r, undefined, 'unknown');
        announce(h, r, downgrade, 'unknown');
        expect(mockNotices).toHaveLength(1);
    });
});

// ── judge: identity recomputed after the call, generator handoff ─────────────

const STORYBOARD = {
    schemaVersion: 1, thesis: 'T',
    slides: [
        { id: 's1', role: 'insight', action_title: 'EMEA grew across the region', core_message: 'm', evidence_span_ids: [], suggested_visual: 'none', visual_data: { type: 'none' } },
        { id: 's2', role: 'recommendation', action_title: 'Double down on EMEA now', core_message: 'm', evidence_span_ids: [], suggested_visual: 'none', visual_data: { type: 'none' } },
    ],
} as unknown as ConsultantStoryboard;

const FINDING = '[{"slideId":null,"dimension":"mece","severity":"major","message":"overlap"}]';

function judgeCtx(result: { success: boolean; content?: string; fidelity?: Fidelity }) {
    const summarizeText = vi.fn(async () => result);
    return { ctx: { llmService: { summarizeText }, settings: { serviceType: 'cloud' as const, cloudServiceType: 'claude' } }, summarizeText };
}

describe('buildStoryboardJudge — independence from fidelity', () => {
    it('different: reports different and tags findings', async () => {
        const { ctx } = judgeCtx({ success: true, content: FINDING, fidelity: fid({ provider: 'claude', reportedModel: 'claude-opus-4-6' }) });
        const seen: string[] = [];
        const judge = buildStoryboardJudge(ctx, [], {
            getGeneratorFidelity: () => fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' }),
            onIndependence: (i) => seen.push(i),
        });
        const v = await judge(STORYBOARD);
        expect(seen).toEqual(['different']);
        expect(v.findings).toHaveLength(1);
        expect(v.findings[0].criticIndependence).toBe('different');
    });

    it('same: both ran on one reported model', async () => {
        const f = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        const { ctx } = judgeCtx({ success: true, content: FINDING, fidelity: f });
        const seen: string[] = [];
        const judge = buildStoryboardJudge(ctx, [], { getGeneratorFidelity: () => f, onIndependence: (i) => seen.push(i) });
        const v = await judge(STORYBOARD);
        expect(seen).toEqual(['same']);
        expect(v.findings[0].criticIndependence).toBe('same');
    });

    it('missing critic fidelity is unknown, never independent', async () => {
        const { ctx } = judgeCtx({ success: true, content: FINDING });
        const seen: string[] = [];
        const judge = buildStoryboardJudge(ctx, [], {
            getGeneratorFidelity: () => fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' }),
            onIndependence: (i) => seen.push(i),
        });
        const v = await judge(STORYBOARD);
        expect(seen).toEqual(['unknown']);
        expect(v.findings[0].criticIndependence).toBe('unknown');
    });

    it('missing generator fidelity is unknown', async () => {
        const { ctx } = judgeCtx({ success: true, content: FINDING, fidelity: fid({ provider: 'claude', reportedModel: 'claude-opus-4-6' }) });
        const seen: string[] = [];
        const judge = buildStoryboardJudge(ctx, [], { onIndependence: (i) => seen.push(i) });
        await judge(STORYBOARD);
        expect(seen).toEqual(['unknown']);
    });

    it('a failed critic call reports nothing and degrades to an empty verdict', async () => {
        const { ctx } = judgeCtx({ success: false });
        const seen: string[] = [];
        const judge = buildStoryboardJudge(ctx, [], { onIndependence: (i) => seen.push(i) });
        expect(await judge(STORYBOARD)).toEqual({ findings: [] });
        expect(seen).toEqual([]);
    });

    it('with no options the findings are untouched (byte-identical off path)', async () => {
        const { ctx } = judgeCtx({ success: true, content: FINDING });
        const v = await buildStoryboardJudge(ctx, [])(STORYBOARD);
        expect(v.findings[0]).toEqual({ slideId: undefined, dimension: 'mece', severity: 'major', message: 'overlap' });
    });
});

describe('generator fidelity reaches the judge (integration)', () => {
    const STORYBOARD_JSON = JSON.stringify(STORYBOARD);

    it('the judge compares against the generation call that produced the storyboard', async () => {
        const genFidelity = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        const criticFidelity = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        const calls: string[] = [];
        const llmService = {
            summarizeText: vi.fn(async (_p: string, o?: { label?: string }) => {
                calls.push(o?.label ?? '');
                if (o?.label === 'presentation-critic') return { success: true, content: '[]', fidelity: criticFidelity };
                return { success: true, content: STORYBOARD_JSON, fidelity: genFidelity };
            }),
        };
        const ctx = { llmService, settings: { serviceType: 'cloud' as const, cloudServiceType: 'claude' } } as never;
        let handed: Fidelity | undefined;
        const seen: string[] = [];
        const judge = buildStoryboardJudge(ctx, [], { getGeneratorFidelity: () => handed, onIndependence: (i) => seen.push(i) });
        const stage = await runStoryboardStage(ctx, 'brief', [], { judge, onFidelity: (f) => { handed = f; } });
        expect(stage.ok).toBe(true);
        expect(calls).toContain('presentation-storyboard');
        expect(calls).toContain('presentation-critic');
        expect(handed).toBe(genFidelity);
        expect(seen).toEqual(['same']);
    });

    it('a failed attempt never overwrites the last successful generation fidelity', async () => {
        const good = fid({ provider: 'claude', reportedModel: 'claude-sonnet-4-6' });
        let n = 0;
        const llmService = {
            summarizeText: vi.fn(async () => {
                n++;
                if (n === 1) return { success: true, content: 'not json', fidelity: good };
                return { success: false, error: 'boom', fidelity: fid({ provider: 'claude', reportedModel: 'other' }) };
            }),
        };
        const ctx = { llmService, settings: { serviceType: 'cloud' as const, cloudServiceType: 'claude' } } as never;
        let handed: Fidelity | undefined;
        const res = await runStoryboardStage(ctx, 'brief', [], { onFidelity: (f) => { handed = f; } });
        expect(res.ok).toBe(false);
        expect(handed).toBe(good);
    });
});
