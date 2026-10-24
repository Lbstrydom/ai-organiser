import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({ applyNoteEdit: vi.fn() }));

import { applyNoteEdit } from '../src/services/noteEdit/applyNoteEdit';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { isLinkRemovalEnabled, planLinkRemoval, removeLinks } from '../src/services/attachmentUnlinkService';
import { describeKept } from '../src/services/attachmentKeptModel';
import { eligibilityFromScan } from '../src/services/attachmentEligibility';

/**
 * "A new capability ships default-off and byte-identical when off": with the shipped defaults nothing in
 * Find embeds can write a note, and the kept card offers only the one-click enable.
 */
describe('link removal is off by default', () => {
	it('is off in the shipped defaults, even with Find embeds on', () => {
		expect(DEFAULT_SETTINGS.attachmentAllowLinkRemoval).toBe(false);
		expect(isLinkRemovalEnabled({ ...DEFAULT_SETTINGS, featureFlags: { 'embed-scan': true } })).toBe(false);
	});

	it('removeLinks writes nothing and says why', async () => {
		const plan = planLinkRemoval('![[a.m4a]]', 'a.m4a', 'n.md', () => 'a.m4a');
		if (plan.status !== 'ok') throw new Error('no plan');
		const plugin = { settings: { ...DEFAULT_SETTINGS, featureFlags: { 'embed-scan': true } }, app: { metadataCache: { getFirstLinkpathDest: () => null } } };
		const res = await removeLinks(plugin as never, 'a.m4a', [plan.plan]);
		expect(res).toEqual({ ok: false, error: 'link-removal-off' });
		expect(vi.mocked(applyNoteEdit)).not.toHaveBeenCalled();
	});

	it('the kept card offers only the enable action, never the removal itself', () => {
		const e = { ...eligibilityFromScan({ path: 'a.m4a', size: 1, mtime: 1 }, 1, false, [], []), blockers: { referrers: [{ path: 'n.md', extension: 'md' as const, lineNumber: 1, linktext: 'a.m4a' }], sameNameFiles: [], unreadable: [] } };
		const card = describeKept({ path: 'a.m4a', name: 'a.m4a', sizeBytes: 1 }, e, { protectedFolders: [], linkRemoval: 'off' });
		expect(card.fileActions).toEqual([{ kind: 'enable-link-removal' }]);
	});
});
