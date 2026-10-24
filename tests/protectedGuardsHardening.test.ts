/**
 * Hardening of the protected-folder guards: Unicode-safe rename rewrites, fail-closed answers when
 * the target cannot be established, transactional settings, and the scan's revision evidence.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { rewriteOnRename, setActiveProtection } from '../src/core/protectedPaths';
import { guardActiveNote, installActiveNoteGuard, referrersProtectedActive } from '../src/utils/protectedGuard';
import { observeMetadataIndex } from '../src/utils/metadataIndexState';
import { applyProtectedFolders, enforceOutputDisjointness, unregisterProtectedFolders } from '../src/commands/protectedFolderCommands';
import { scanNotes } from '../src/services/embedScanService';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { clearMockNotices, mockNotices } from './mocks/obsidian';
import { makeFakeApp } from './helpers/fakeVault';

afterEach(() => {
	setActiveProtection(null);
	installActiveNoteGuard(null, null);
	unregisterProtectedFolders();
	clearMockNotices();
});

describe('rewriteOnRename is safe for characters whose lower case has a different length', () => {
	it('rewrites by segment, not by string offset', () => {
		// "İ" (U+0130) lower-cases to two code units, so a lower-cased offset is not an offset into the original.
		expect(rewriteOnRename(['İstanbul/Notes/Deep'], 'İstanbul', 'Archive/Istanbul')).toEqual({
			list: ['Archive/Istanbul/Notes/Deep'],
			changed: true,
		});
	});

	it('still ignores a sibling and an unrelated entry', () => {
		expect(rewriteOnRename(['İstanbulX/a', 'Other'], 'İstanbul', 'Z')).toEqual({ list: ['İstanbulX/a', 'Other'], changed: false });
	});
});

describe('guards fail closed when the target cannot be established', () => {
	const editor = {} as never;

	it('refuses an editor whose note cannot be identified while a folder is protected', () => {
		setActiveProtection(() => ['P']);
		installActiveNoteGuard(() => 'Other/active.md', () => 'protected', () => null);
		expect(guardActiveNote(editor)).toBe(false);
		expect(mockNotices).toContain('protected');
	});

	it('checks the editor\'s own note, not the active one', () => {
		setActiveProtection(() => ['P']);
		installActiveNoteGuard(() => 'Other/active.md', () => 'protected', () => 'P/owned.md');
		expect(guardActiveNote(editor)).toBe(false);
		installActiveNoteGuard(() => 'P/active.md', () => 'protected', () => 'Other/owned.md');
		expect(guardActiveNote(editor)).toBe(true);
	});

	it('allows an unidentifiable editor when nothing is protected', () => {
		setActiveProtection(() => []);
		installActiveNoteGuard(() => 'x.md', () => 'protected', () => null);
		expect(guardActiveNote(editor)).toBe(true);
	});

	it('treats missing link data as "protected referrers may exist" only while something is protected', () => {
		const app = { metadataCache: {} } as never;
		setActiveProtection(() => []);
		expect(referrersProtectedActive(app, 'a.pdf')).toBe(false);
		setActiveProtection(() => ['P']);
		expect(referrersProtectedActive(app, 'a.pdf')).toBe(true);
	});

	it('finds a protected note that links to the file', () => {
		setActiveProtection(() => ['P']);
		const metadataCache = { resolvedLinks: { 'P/n.md': { 'a.pdf': 1 }, 'Q/m.md': { 'a.pdf': 1 } } };
		observeMetadataIndex(metadataCache).resolved(); // a completely indexed vault
		const app = { metadataCache } as never;
		expect(referrersProtectedActive(app, 'a.pdf')).toBe(true);
		expect(referrersProtectedActive(app, 'other.pdf')).toBe(false);
	});

	it('an index whose completeness cannot be established is not a complete footprint (fails closed while protected)', () => {
		setActiveProtection(() => ['P']);
		const links = { 'Q/m.md': { 'a.pdf': 1 } };
		// Obsidian 1.14.5 shape: `initialized` but no `resolved`; nothing observed yet => not provably complete.
		const unobserved = { metadataCache: { initialized: true, resolvedLinks: links } } as never;
		expect(referrersProtectedActive(unobserved, 'other.pdf')).toBe(true);
		// Same index once a completed resolution has been observed: only real referrers count.
		const cache = { initialized: true, resolvedLinks: links };
		observeMetadataIndex(cache).resolved();
		expect(referrersProtectedActive({ metadataCache: cache } as never, 'other.pdf')).toBe(false);
		// Still being built (flag false): fail closed regardless of what was observed.
		const building = { initialized: false, resolvedLinks: links };
		observeMetadataIndex(building).resolved();
		expect(referrersProtectedActive({ metadataCache: building } as never, 'other.pdf')).toBe(true);
		// Nothing protected: nothing to refuse.
		setActiveProtection(() => []);
		expect(referrersProtectedActive(unobserved, 'other.pdf')).toBe(false);
	});
});

describe('applyProtectedFolders is transactional', () => {
	beforeEach(() => unregisterProtectedFolders());

	it('restores the previous list and returns an error result when saving throws', async () => {
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), protectedFolders: ['Old'] },
			t: en,
			saveSettings: vi.fn(async () => { throw new Error('disk full'); }),
		};
		const res = await applyProtectedFolders(plugin as never, ['New']);
		expect(res.ok).toBe(false);
		expect(plugin.settings.protectedFolders).toEqual(['Old']);
	});
});

describe('a collision caused by the protected list is accepted, not reverted', () => {
	it('keeps following a moved protected folder and warns instead of undoing output settings', () => {
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), protectedFolders: ['Courses'] },
			t: en,
			settingTab: { display: vi.fn() },
		};
		enforceOutputDisjointness(plugin as never); // baseline
		// Obsidian moved the protected folder so that it now contains the plugin folder; output settings are unchanged.
		plugin.settings.protectedFolders = ['AI-Organiser'];
		expect(enforceOutputDisjointness(plugin as never)).toBe(false);
		expect(plugin.settings.protectedFolders).toEqual(['AI-Organiser']);
		expect(plugin.settingTab.display).not.toHaveBeenCalled();
		expect(mockNotices.length).toBeGreaterThan(0);
	});
});

describe('scan revision evidence', () => {
	it('records the modified time that existed before the read, and "unknown" when it changed during it', async () => {
		const v = makeFakeApp({ 'a.pdf': {}, 'stable.md': { text: '![[a.pdf]]', mtime: 500 }, 'racy.md': { text: '![[a.pdf]]', mtime: 600 } });
		const racy = v.files.get('racy.md')!;
		const originalRead = v.app.vault.cachedRead;
		v.app.vault.cachedRead = async (f) => {
			const text = await originalRead(f);
			if (f.path === 'racy.md') racy.stat = { ...racy.stat, mtime: 601 };
			return text;
		};
		const result = await scanNotes(v.app as never, [v.files.get('stable.md')!, racy] as never);
		expect(result.scannedReferrers).toEqual([
			{ path: 'stable.md', mtime: 500 },
			{ path: 'racy.md', mtime: -1 },
		]);
	});
});

describe('guardActiveNote without an editor', () => {
	it('refuses while a folder is protected and no way to identify the active note was installed', () => {
		setActiveProtection(() => ['Course']);
		installActiveNoteGuard(null, null);
		expect(guardActiveNote()).toBe(false);
	});

	it('allows when nothing is protected, and when there is no active note to protect', () => {
		installActiveNoteGuard(null, null);
		expect(guardActiveNote()).toBe(true); // nothing protected
		setActiveProtection(() => ['Course']);
		installActiveNoteGuard(() => null, null);
		expect(guardActiveNote()).toBe(true); // the provider answers: there is no active note
		installActiveNoteGuard(() => 'Course/a.md', null);
		expect(guardActiveNote()).toBe(false);
		installActiveNoteGuard(() => 'Other/a.md', null);
		expect(guardActiveNote()).toBe(true);
	});
});
