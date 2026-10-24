/**
 * The parts of a setup wizard that the inbox sweep and the capture inbox share: they read the same inbox
 * folders and honour the same keep-out rules, so the questions, their validation and their wording are one
 * piece of code. The report path (sweep) and the destination folder and limits (capture) stay with their own
 * wizard.
 */
import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { guardSnapshot, policyRevisionOf, propertiesAreReadable, type SweepPolicy } from '../../services/inboxSweep/sweepGuard';
import { buildSnapshot } from '../../services/inboxSweep/noteSnapshot';
import { FolderListEditor } from './FolderListEditor';

/** One entry per line or comma. */
export const lines = (text: string): string[] => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
/** One entry per line, commas kept: a property value may contain one. */
export const propertyLines = (text: string): string[] => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** The shared part of a wizard's draft: what is edited in the steps, as text where the UI uses text. */
export interface ScopeDraft {
    inbox: string[];
    excludedFolders: string[];
    tags: string;
    properties: string;
    terms: string;
    nothing: boolean;
}

type ScopeSettings = {
    sweepInboxFolders: string[];
    sweepExcludedFolders: string[];
    sweepExcludedTags: string[];
    sweepExcludedProperties: string[];
    sweepExcludedTerms: string[];
    sweepNothingToExclude: boolean;
};

export function draftFromSettings(s: ScopeSettings): ScopeDraft {
    return {
        inbox: [...s.sweepInboxFolders],
        excludedFolders: [...s.sweepExcludedFolders],
        tags: s.sweepExcludedTags.join('\n'),
        properties: s.sweepExcludedProperties.join('\n'),
        terms: s.sweepExcludedTerms.join('\n'),
        nothing: s.sweepNothingToExclude,
    };
}

export function exclusionCount(d: ScopeDraft): number {
    return d.excludedFolders.length + lines(d.tags).length + propertyLines(d.properties).length + lines(d.terms).length;
}

/**
 * The keep-out step's rule: a property rule must be readable, and there must be at least one rule or the
 * explicit "nothing to keep out". `requiredCode` is the feature's own guidance code.
 */
export function validateKeepOut(d: ScopeDraft, requiredCode: string): Result<void> {
    if (!propertiesAreReadable(propertyLines(d.properties))) return err('sweep-property-invalid');
    return exclusionCount(d) === 0 && !d.nothing ? err(requiredCode) : ok(undefined);
}

/** The settings values a finished draft produces (the "nothing to keep out" flag only stands with no rules). */
export function scopeValues(d: ScopeDraft): {
    sweepInboxFolders: string[];
    sweepExcludedFolders: string[];
    sweepExcludedTags: string[];
    sweepExcludedProperties: string[];
    sweepExcludedTerms: string[];
    sweepNothingToExclude: boolean;
} {
    return {
        sweepInboxFolders: d.inbox,
        sweepExcludedFolders: d.excludedFolders,
        sweepExcludedTags: lines(d.tags).map((x) => x.replace(/^#/, '')),
        sweepExcludedProperties: propertyLines(d.properties),
        sweepExcludedTerms: lines(d.terms),
        sweepNothingToExclude: exclusionCount(d) === 0 && d.nothing,
    };
}

export interface KeepOutStrings {
    keepOutHelp: string;
    keepOutFolders: string;
    keepOutTags: string;
    keepOutTagsDesc: string;
    keepOutProps: string;
    keepOutPropsDesc: string;
    keepOutTerms: string;
    keepOutTermsDesc: string;
    nothingToKeepOut: string;
    nothingToKeepOutDesc: string;
}

/** The inbox folder picker, bound to the draft. */
export function renderInboxFolders(plugin: AIOrganiserPlugin, el: HTMLElement, d: ScopeDraft): void {
    new FolderListEditor({ app: plugin.app, container: el, t: plugin.t, getFolders: () => d.inbox, onChange: (n) => { d.inbox = [...n]; } }).render();
}

/** The body of the keep-out step, bound to the draft. */
export function renderKeepOut(plugin: AIOrganiserPlugin, el: HTMLElement, d: ScopeDraft, c: KeepOutStrings): void {
    el.createEl('p', { text: c.keepOutHelp });
    el.createEl('h4', { text: c.keepOutFolders });
    new FolderListEditor({ app: plugin.app, container: el, t: plugin.t, getFolders: () => d.excludedFolders, onChange: (n) => { d.excludedFolders = [...n]; } }).render();
    new Setting(el).setName(c.keepOutTags).setDesc(c.keepOutTagsDesc).addTextArea((ta) => ta.setValue(d.tags).onChange((v) => { d.tags = v; }));
    new Setting(el).setName(c.keepOutProps).setDesc(c.keepOutPropsDesc).addTextArea((ta) => ta.setValue(d.properties).onChange((v) => { d.properties = v; }));
    new Setting(el).setName(c.keepOutTerms).setDesc(c.keepOutTermsDesc).addTextArea((ta) => ta.setValue(d.terms).onChange((v) => { d.terms = v; }));
    new Setting(el).setName(c.nothingToKeepOut).setDesc(c.nothingToKeepOutDesc).addToggle((tg) => tg.setValue(d.nothing).onChange((v) => { d.nothing = v; }));
}

/** Count what the draft's rules would let through and keep out. Reads local notes only; no provider is contacted. */
export async function previewScope(plugin: AIOrganiserPlugin, d: ScopeDraft, base: SweepPolicy): Promise<{ allowed: number; kept: number }> {
    const policy: SweepPolicy = {
        ...base,
        excludedFolders: d.excludedFolders,
        excludedTags: lines(d.tags),
        excludedProperties: propertyLines(d.properties),
        excludedTerms: lines(d.terms),
    };
    const revision = await policyRevisionOf(policy);
    const folders = d.inbox.map(normalisePath);
    let allowed = 0;
    let kept = 0;
    for (const f of plugin.app.vault.getMarkdownFiles()) {
        if (!folders.some((folder) => isInsideOrEqual(normalisePath(f.path), folder))) continue;
        const text = await plugin.app.vault.cachedRead(f);
        const snap = await buildSnapshot(f.path, text, revision);
        if (guardSnapshot(snap, policy, revision).allowed) allowed++;
        else kept++;
    }
    return { allowed, kept };
}

/**
 * Set several settings at once and save. If saving fails, put back only what THIS call set, and only where
 * nothing else (a rename) changed it since. Returns `write-failed` in that case.
 */
export async function applySettingsWithRollback(
    plugin: AIOrganiserPlugin,
    patch: Record<string, unknown>,
    marker?: { id: string; value: string },
): Promise<Result<void>> {
    const s = plugin.settings as unknown as Record<string, unknown> & { featureSetupCompletedAt: Record<string, string> };
    const before = new Map<string, unknown>();
    for (const key of Object.keys(patch)) before.set(key, s[key]);
    const markerBefore = marker ? s.featureSetupCompletedAt[marker.id] : undefined;
    for (const [key, value] of Object.entries(patch)) s[key] = value;
    if (marker) s.featureSetupCompletedAt[marker.id] = marker.value;
    try {
        await plugin.saveSettings();
        return ok(undefined);
    } catch {
        for (const [key, value] of Object.entries(patch)) if (s[key] === value) s[key] = before.get(key);
        if (marker && s.featureSetupCompletedAt[marker.id] === marker.value) {
            if (markerBefore === undefined) delete s.featureSetupCompletedAt[marker.id];
            else s.featureSetupCompletedAt[marker.id] = markerBefore;
        }
        return err('write-failed');
    }
}
