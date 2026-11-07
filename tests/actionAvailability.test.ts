import { describe, it, expect } from 'vitest';
import { actionAvailability, actionFeatureOn, AVAILABILITY_PRECEDENCE, type AvailabilityContext } from '../src/core/actionAvailability';
import { ACTION_BY_ID, type ActionDef } from '../src/core/actionRegistry';
import type { FeatureId } from '../src/core/features';
import { toStoredTarget, isStoredTarget } from '../src/core/actionTarget';
import { TFile, TFolder } from 'obsidian';

const def = (id: string): ActionDef => ACTION_BY_ID.get(id)!;
const ctx = (over: Partial<AvailabilityContext> = {}): AvailabilityContext => ({
    isEnabled: () => true,
    isMobile: false,
    requirementMet: () => true,
    ...over,
});

describe('actionAvailability — each state', () => {
    it('ready when everything is met', () => {
        expect(actionAvailability(def('sweep-inbox'), ctx())).toEqual({ state: 'ready', reasons: [] });
    });
    it('feature-off', () => {
        expect(actionAvailability(def('sweep-inbox'), ctx({ isEnabled: (f) => f !== 'inbox-sweep' })).state).toBe('feature-off');
    });
    it('desktop-only on mobile, ready on desktop', () => {
        expect(actionAvailability(def('resume-offload'), ctx({ isMobile: true })).state).toBe('desktop-only');
        expect(actionAvailability(def('resume-offload'), ctx()).state).toBe('ready');
        expect(actionAvailability(def('sweep-inbox'), ctx({ isMobile: true })).state).toBe('ready');
    });
    it('wrong-target when the requirement is unmet', () => {
        expect(actionAvailability(def('play-narration'), ctx({ requirementMet: (r) => r !== 'mp3-file' })).state).toBe('wrong-target');
    });
    it('needs-setup and missing-key come from the caller\'s checks', () => {
        expect(actionAvailability(def('sweep-inbox'), ctx({ isSetupDone: () => false })).state).toBe('needs-setup');
        expect(actionAvailability(def('sweep-inbox'), ctx({ hasKey: () => false })).state).toBe('missing-key');
        expect(actionAvailability(def('sweep-inbox'), ctx({ isSetupDone: () => undefined, hasKey: () => undefined })).state).toBe('ready');
    });
});

describe('actionAvailability — precedence and reasons', () => {
    it('desktop-only beats feature-off beats setup and target', () => {
        const all = ctx({ isMobile: true, isEnabled: () => false, requirementMet: () => false });
        const r = actionAvailability(def('resume-offload'), all);
        expect(r.state).toBe('desktop-only');
        expect(r.reasons).toEqual(['desktop-only', 'feature-off', 'wrong-target']);
    });
    it('setup and key are not asked about an off feature', () => {
        const r = actionAvailability(def('sweep-inbox'), ctx({ isEnabled: () => false, isSetupDone: () => false, hasKey: () => false }));
        expect(r.reasons).toEqual(['feature-off']);
    });
    it('reasons are always in precedence order', () => {
        const r = actionAvailability(def('sweep-inbox'), ctx({ isSetupDone: () => false, hasKey: () => false, requirementMet: () => false }));
        expect(r.reasons).toEqual(['needs-setup', 'missing-key', 'wrong-target']);
        expect(AVAILABILITY_PRECEDENCE[0]).toBe('desktop-only');
    });
});

describe('actionFeatureOn — OR and AND gates', () => {
    const on = (...fs: FeatureId[]) => (f: FeatureId) => fs.includes(f);
    it('Open Process: any feeding feature', () => {
        expect(actionFeatureOn(def('open-process'), on('inbox-sweep'))).toBe(true);
        expect(actionFeatureOn(def('open-process'), on('chat'))).toBe(false);
    });
    it('Review AI hand-back: both features', () => {
        expect(actionFeatureOn(def('review-ai-handback'), on('ai-workspaces'))).toBe(false);
        expect(actionFeatureOn(def('review-ai-handback'), on('ai-workspaces', 'capture-inbox'))).toBe(true);
    });
    it('fails closed with no feature', () => {
        expect(actionFeatureOn({}, () => true)).toBe(false);
    });
});

describe('actionTarget — what survives a reload', () => {
    const file = Object.assign(new TFile(), { path: 'a/b.md' });
    const folder = Object.assign(new TFolder(), { path: 'a' });
    it('stores files and folders by path', () => {
        expect(toStoredTarget({ kind: 'file', file })).toEqual({ kind: 'file', path: 'a/b.md' });
        expect(toStoredTarget({ kind: 'folder', folder })).toEqual({ kind: 'folder', path: 'a' });
    });
    it('never stores the vault root, which has no path to check', () => {
        const root = Object.assign(new TFolder(), { path: '' });
        expect(toStoredTarget({ kind: 'folder', folder: root })).toBeNull();
    });
    it('never stores a selection, a multi-file pick or the active context', () => {
        expect(toStoredTarget({ kind: 'active' })).toBeNull();
        expect(toStoredTarget({ kind: 'files', files: [file] })).toBeNull();
        expect(toStoredTarget({ kind: 'selection', file, text: 'x', from: 0, to: 1 })).toBeNull();
    });
    it('validates stored values read back from settings', () => {
        expect(isStoredTarget({ kind: 'file', path: 'x.md' })).toBe(true);
        expect(isStoredTarget({ kind: 'selection', path: 'x.md' })).toBe(false);
        expect(isStoredTarget({ kind: 'file', path: '' })).toBe(false);
        expect(isStoredTarget(null)).toBe(false);
    });
});
