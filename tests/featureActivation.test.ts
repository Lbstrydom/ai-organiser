/**
 * Turning a feature on from the picker (docs/plans/navigation-discoverability.md, decision 3):
 * the plan, the single settings write, the reload adapter's failure states, and the one-shot
 * resume offer.
 */
import { describe, it, expect, vi } from 'vitest';
import { clearMockNotices, mockNotices } from './mocks/obsidian';
import { applyActivation, consumePendingResume, planActivation, featureToActivate, type ActivationHost } from '../src/services/featureActivation';
import { reloadSelf } from '../src/services/pluginLifecycle';
import { RESUME_MAX_AGE_MS, isResumeIntent, type ResumeIntent } from '../src/core/resumeIntent';
import type { Availability } from '../src/core/actionAvailability';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { GUIDANCE_CODES } from '../src/core/friendlyErrors';
import { en } from '../src/i18n/en';

const ready: Availability = { state: 'ready', reasons: [] };

describe('planActivation', () => {
    it('names the features turned on as well (Google Tasks needs the inbox sweep)', () => {
        const plan = planActivation({}, 'google-tasks-export', false);
        expect(plan.also).toContain('inbox-sweep');
        expect(plan.flags['google-tasks-export']).toBe(true);
        expect(plan.flags['inbox-sweep']).toBe(true);
    });

    it('lists every action it adds and its own setup actions', () => {
        const plan = planActivation({}, 'inbox-sweep', false);
        expect(plan.adds.map((a) => a.id)).toEqual(expect.arrayContaining(['sweep-inbox', 'setup-inbox-sweep']));
        expect(plan.setup.map((a) => a.id)).toEqual(['setup-inbox-sweep']);
        expect(plan.also).toEqual([]);
    });

    it('blocks a feature whose every action is desktop-only, on mobile only', () => {
        expect(planActivation({}, 'cloud-offload', true).blocked).toBe('desktop-only');
        expect(planActivation({}, 'cloud-offload', false).blocked).toBeUndefined();
        expect(planActivation({}, 'inbox-sweep', true).blocked).toBeUndefined();
    });

    it('maps an action to its owning feature', () => {
        expect(featureToActivate('sweep-inbox')).toBe('inbox-sweep');
        expect(featureToActivate('no-such-action')).toBeNull();
    });
});

describe('applyActivation — one write for flags and intent', () => {
    const intent: ResumeIntent = { v: 1, kind: 'action', commandId: 'sweep-inbox', createdAt: 1000 };
    const host = (save: () => Promise<void>): ActivationHost => ({ settings: { featureFlags: { tagging: true } }, saveSettings: save });

    it('saves the new flags and the intent together', async () => {
        const h = host(async () => {});
        const spy = vi.spyOn(h, 'saveSettings');
        const r = await applyActivation(h, planActivation(h.settings.featureFlags, 'inbox-sweep', false), intent);
        expect(r.ok).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(h.settings.featureFlags['inbox-sweep']).toBe(true);
        expect(h.settings.pendingResume).toEqual(intent);
    });

    it('a failed save restores both and reports save-failed (nothing reloads)', async () => {
        const h = host(async () => { throw new Error('disk full'); });
        const r = await applyActivation(h, planActivation(h.settings.featureFlags, 'inbox-sweep', false), intent);
        expect(r).toEqual({ ok: false, error: 'save-failed' });
        expect(h.settings.featureFlags).toEqual({ tagging: true });
        expect(h.settings.pendingResume).toBeUndefined();
    });

    it('a blocked plan writes nothing', async () => {
        const h = host(async () => {});
        const spy = vi.spyOn(h, 'saveSettings');
        const r = await applyActivation(h, planActivation({}, 'cloud-offload', true), intent);
        expect(r.ok).toBe(false);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('reloadSelf — the internal plugin API adapter', () => {
    it('reports unsupported, touching nothing, when the API is missing', () => {
        expect(reloadSelf({}, 'ai-organiser', 'x')).toEqual({ ok: false, error: 'activation-reload-unsupported' });
        expect(reloadSelf({ plugins: { disablePlugin: () => Promise.resolve() } }, 'ai-organiser', 'x').ok).toBe(false);
    });

    it('reports unsupported when disable throws synchronously', () => {
        const app = { plugins: { disablePlugin: () => { throw new Error('no'); }, enablePlugin: vi.fn() } };
        expect(reloadSelf(app, 'ai-organiser', 'x')).toEqual({ ok: false, error: 'activation-reload-unsupported' });
        expect(app.plugins.enablePlugin).not.toHaveBeenCalled();
    });

    it('disables then enables the same plugin id', async () => {
        const calls: string[] = [];
        const app = { plugins: { disablePlugin: async (id: string) => { calls.push('off:' + id); }, enablePlugin: async (id: string) => { calls.push('on:' + id); } } };
        expect(reloadSelf(app, 'ai-organiser', 'x').ok).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toEqual(['off:ai-organiser', 'on:ai-organiser']);
    });

    it('shows the pre-captured guidance when the re-enable fails after unload', async () => {
        clearMockNotices();
        const app = { plugins: { disablePlugin: async () => {}, enablePlugin: async () => { throw new Error('boom'); } } };
        expect(reloadSelf(app, 'ai-organiser', 'Turn it back on').ok).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        expect(mockNotices).toEqual(['Turn it back on']);
    });

    it('both failure codes carry guidance', () => {
        for (const code of ['activation-reload-unsupported', 'activation-reenable-failed'] as const) {
            expect((GUIDANCE_CODES as readonly string[]).includes(code)).toBe(true);
            expect(en.guidance[code].message.length).toBeGreaterThan(0);
            expect(en.guidance[code].nextStep.length).toBeGreaterThan(0);
        }
    });
});

describe('consumePendingResume — the one-shot offer', () => {
    const now = 1_000_000;
    const ctx = (over: Partial<Parameters<typeof consumePendingResume>[1]> = {}) => ({
        now, availabilityOf: () => ready, pathExists: () => true, ...over,
    });
    const intent = (over: Partial<ResumeIntent> = {}): ResumeIntent =>
        ({ v: 1, kind: 'action', commandId: 'sweep-inbox', createdAt: now - 1000, ...over }) as ResumeIntent;

    it('offers Continue when the action is now ready', () => {
        expect(consumePendingResume(intent(), ctx())).toEqual({ kind: 'continue', commandId: 'sweep-inbox', feature: 'inbox-sweep' });
    });

    it('says why when the action is still not ready', () => {
        const offer = consumePendingResume(intent(), ctx({ availabilityOf: () => ({ state: 'needs-setup', reasons: ['needs-setup'] }) }));
        expect(offer).toEqual({ kind: 'not-ready', commandId: 'sweep-inbox', feature: 'inbox-sweep', reason: 'needs-setup' });
    });

    it('drops an intent older than ten minutes, or from the future', () => {
        expect(consumePendingResume(intent({ createdAt: now - RESUME_MAX_AGE_MS - 1 }), ctx()).kind).toBe('none');
        expect(consumePendingResume(intent({ createdAt: now + 5000 }), ctx()).kind).toBe('none');
    });

    it('drops an intent whose stored file is gone, or whose action no longer exists', () => {
        expect(consumePendingResume(intent({ target: { kind: 'file', path: 'gone.md' } } as Partial<ResumeIntent>), ctx({ pathExists: () => false })).kind).toBe('none');
        expect(consumePendingResume(intent({ commandId: 'retired-action' } as Partial<ResumeIntent>), ctx()).kind).toBe('none');
    });

    it('passes a job intent through for the job surface', () => {
        expect(consumePendingResume({ v: 1, kind: 'job', jobId: 'process-inbox', createdAt: now }, ctx())).toEqual({ kind: 'job', jobId: 'process-inbox' });
    });

    it('nothing stored, nothing offered', () => {
        expect(consumePendingResume(undefined, ctx()).kind).toBe('none');
    });
});

describe('resume intent shape', () => {
    it('accepts v1 actions and jobs, rejects anything else', () => {
        expect(isResumeIntent({ v: 1, kind: 'action', commandId: 'a', createdAt: 1 })).toBe(true);
        expect(isResumeIntent({ v: 1, kind: 'job', jobId: 'j', createdAt: 1 })).toBe(true);
        expect(isResumeIntent({ v: 1, kind: 'action', commandId: '', createdAt: 1 })).toBe(false);
        expect(isResumeIntent({ v: 1, kind: 'selection', createdAt: 1 })).toBe(false);
        expect(isResumeIntent({ v: 1, kind: 'action', commandId: 'a', createdAt: Number.NaN })).toBe(false);
    });

    it('the default settings carry no pending resume', () => {
        expect(DEFAULT_SETTINGS.pendingResume).toBeUndefined();
    });
});
