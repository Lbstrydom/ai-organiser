/**
 * Deferred storyline .md materialization (storyline-deferred-materialization).
 *
 * The working storyline lives in memory (conversation state); a .md is written
 * only on an explicit Save / Create-deck. These tests pin: two review CTAs,
 * onClear clears the pending storyline, the snapshot round-trips a pending
 * storyline (crash-safety), and Save writes once then updates in place.
 */
import { describe, it, expect, vi } from 'vitest';

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { TFile } from './mocks/obsidian';
import { en } from '../src/i18n/en';

// A known-valid ConsultantStoryboard (mirrors tests/consultantStoryboard.test.ts).
const STORYBOARD = {
    schemaVersion: 1,
    thesis: 'Growth was regionally concentrated',
    slides: [{
        id: 's1',
        role: 'insight' as const,
        action_title: 'EMEA drove 60% of Q3 growth',
        core_message: 'Regional revenue concentration',
        evidence_span_ids: ['e1'],
        suggested_visual: 'bar' as const,
        visual_data: { type: 'bar' as const, unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }] },
    }],
};

function makeHandler(): PresentationModeHandler {
    return new PresentationModeHandler();
}

function setPending(h: PresentationModeHandler, extra: Record<string, unknown> = {}): void {
    (h as unknown as { pendingStoryline: unknown }).pendingStoryline = {
        catalog: [],
        storyboard: STORYBOARD,
        storylineMarkdown: '# My Deck\n\n## A so-what title\n- supporting point',
        deckName: 'My Deck',
        ...extra,
    };
}

const pending = (h: PresentationModeHandler) => (h as unknown as { pendingStoryline: unknown }).pendingStoryline;

describe('deferred storyline materialization', () => {
    it('review gate shows exactly two CTAs: Save storyline + Create deck', () => {
        const h = makeHandler();
        setPending(h); // pending + no deck
        const actions = h.getActionDescriptors(en);
        expect(actions.map(a => a.id)).toEqual(['save-storyline-note', 'create-deck-from-storyline']);
        expect(actions.find(a => a.id === 'create-deck-from-storyline')?.isDefault).toBe(true);
    });

    it('getLayoutState reports reviewingStoryline while a storyline is pending (no deck)', () => {
        const h = makeHandler();
        setPending(h);
        expect(h.getLayoutState().reviewingStoryline).toBe(true);
        // …and false once cleared.
        h.onClear();
        expect(h.getLayoutState().reviewingStoryline).toBe(false);
    });

    it('onClear clears the pending storyline (latent-leak fix)', () => {
        const h = makeHandler();
        setPending(h);
        expect(pending(h)).not.toBeNull();
        h.onClear();
        expect(pending(h)).toBeNull();
    });

    it('getSerializableState carries the pending storyline when there is no deck', () => {
        const h = makeHandler();
        setPending(h, { savedNotePath: 'AI-Organiser/Presentations/My Deck — storyline.md' });
        const snap = h.getSerializableState() as { pendingStoryline?: { storyboard?: unknown; deckName?: string; savedNotePath?: string } } | null;
        expect(snap?.pendingStoryline?.deckName).toBe('My Deck');
        expect(snap?.pendingStoryline?.storyboard).toBeDefined();
        expect(snap?.pendingStoryline?.savedNotePath).toBe('AI-Organiser/Presentations/My Deck — storyline.md');
    });

    it('getSerializableState returns null with neither a deck nor a pending storyline', () => {
        expect(makeHandler().getSerializableState()).toBeNull();
    });

    it('round-trips a pending storyline through serialize → restore (crash-safety)', () => {
        const a = makeHandler();
        setPending(a);
        const snap = a.getSerializableState();

        const b = makeHandler();
        expect(b.restoreState(snap)).toBe(true);
        const restored = pending(b) as { storyboard: { thesis: string }; deckName: string; storylineMarkdown: string };
        expect(restored.storyboard.thesis).toBe(STORYBOARD.thesis);
        expect(restored.deckName).toBe('My Deck');
        // Markdown is re-derived from the storyboard on restore.
        expect(restored.storylineMarkdown).toContain('My Deck');
        // The two review CTAs are available again after restore.
        expect(b.getActionDescriptors(en).map(x => x.id)).toEqual(['save-storyline-note', 'create-deck-from-storyline']);
    });

    it('Save writes a .md once, then updates the SAME file in place', async () => {
        const h = makeHandler();
        const created: string[] = [];
        const modified: string[] = [];
        const folder = { /* TFolder stand-in */ };
        const savedFile = new TFile();
        savedFile.path = 'AI-Organiser/Presentations/My Deck — storyline.md';

        let fileExists = false;
        const vault = {
            getAbstractFileByPath: vi.fn((p: string) => {
                if (p === 'AI-Organiser/Presentations') return folder;       // folder exists
                if (p === savedFile.path && fileExists) return savedFile;    // saved note (2nd call)
                return null;
            }),
            createFolder: vi.fn(async () => {}),
            create: vi.fn(async (p: string) => { created.push(p); fileExists = true; return savedFile; }),
            modify: vi.fn(async (_f: unknown, _c: string) => { modified.push(savedFile.path); }),
        };
        const ctx: unknown = {
            app: { vault },
            plugin: { t: en, settings: { pluginFolder: 'AI-Organiser', presentationOutputFolder: 'Presentations' } },
        };

        setPending(h);
        const save = (h as unknown as { saveStorylineNote: (c: unknown, p: unknown) => Promise<string> }).saveStorylineNote.bind(h);

        const path1 = await save(ctx, pending(h));
        expect(created).toEqual([savedFile.path]);          // first Save → create
        expect((pending(h) as { savedNotePath?: string }).savedNotePath).toBe(savedFile.path);

        const path2 = await save(ctx, pending(h));
        expect(path2).toBe(path1);
        expect(created).toEqual([savedFile.path]);          // no second create
        expect(modified).toEqual([savedFile.path]);         // second Save → modify same file
    });
});
