/**
 * Prompt caching — tagging loops that fire one single-note tag after another.
 *
 * A newsletter fetch (up to `newsletterFetchLimit` notes) and a Kindle import
 * tag their notes back to back, so the ~3.5k-token taxonomy head repeats inside
 * the 5-minute cache TTL even though each call is a single-note tag. Those loops
 * mark the prefix cacheable; a one-note loop and the one-off commands do not.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));
vi.mock('../src/services/privacyNotice', () => ({ ensurePrivacyConsent: vi.fn(async () => true) }));

import { TFile } from 'obsidian';
import { NewsletterService } from '../src/services/newsletter/newsletterService';
import { KindleSyncModal } from '../src/ui/modals/KindleSyncModal';

const vault = (): { getAbstractFileByPath: (p: string) => TFile; read: () => Promise<string> } => ({
    getAbstractFileByPath: (p: string) => Object.assign(new TFile(), { path: p, basename: p }),
    read: async () => 'note body',
});

describe('newsletter post-processing tags its notes with a cacheable prefix', () => {
    const run = async (paths: string[]): Promise<Array<boolean | undefined>> => {
        const analyze = vi.fn(async () => ({ success: true, message: 'ok', tags: [] }));
        const svc = Object.create(NewsletterService.prototype) as {
            plugin: unknown;
            postProcessNotes(paths: string[], newsletters: unknown[]): Promise<void>;
        };
        svc.plugin = {
            app: { vault: vault() },
            settings: { newsletterAutoTag: true, enableStructuredMetadata: false },
            analyzeAndTagNote: analyze,
        };
        await svc.postProcessNotes(paths, []);
        return (analyze.mock.calls as unknown[][]).map((c) => (c[2] as { cacheTagPrefix?: boolean } | undefined)?.cacheTagPrefix);
    };

    it('a fetch of several notes marks every call', async () => {
        expect(await run(['a.md', 'b.md', 'c.md'])).toEqual([true, true, true]);
    });

    it('a fetch of one note does not', async () => {
        expect(await run(['a.md'])).toEqual([false]);
    });
});

describe('Kindle import tagging uses a cacheable prefix', () => {
    const run = async (count: number): Promise<Array<boolean | undefined>> => {
        const analyze = vi.fn(async () => ({ success: true, message: 'ok', tags: [] }));
        const modal = Object.create(KindleSyncModal.prototype) as Record<string, unknown> & {
            runAIEnhancement(onProgress: (p: unknown) => void): Promise<void>;
        };
        Object.assign(modal, {
            autoTag: true,
            abortController: new AbortController(),
            app: { vault: vault() },
            plugin: {
                settings: { serviceType: 'cloud', enableStructuredMetadata: false },
                analyzeAndTagNote: analyze,
            },
            createdFiles: Array.from({ length: count }, (_v, i) => ({ path: `book${i}.md`, title: `Book ${i}` })),
        });
        await modal.runAIEnhancement(() => {});
        return (analyze.mock.calls as unknown[][]).map((c) => (c[2] as { cacheTagPrefix?: boolean } | undefined)?.cacheTagPrefix);
    };

    it('several books mark every call', async () => {
        expect(await run(3)).toEqual([true, true, true]);
    });

    it('one book does not', async () => {
        expect(await run(1)).toEqual([false]);
    });
});
