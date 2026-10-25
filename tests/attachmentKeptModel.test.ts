import { describe, it, expect } from 'vitest';
import { describeKept, type KeptContext } from '../src/services/attachmentKeptModel';
import type { Eligibility, IneligibleReason } from '../src/services/attachmentEligibility';

const file = { path: 'Rec/meeting.m4a', name: 'meeting.m4a', sizeBytes: 120 };
const ctx = (over: Partial<KeptContext> = {}): KeptContext => ({ protectedFolders: [], linkRemoval: 'on', ...over });
const elig = (reasons: IneligibleReason[], blockers: Eligibility['blockers'] = { referrers: [], sameNameFiles: [], unreadable: [] }, referenceCount = 0): Eligibility => ({
	eligible: false,
	reasons,
	referenceCount,
	blockers,
});
const noteRef = (path: string, line = 3) => ({ path, extension: 'md' as const, lineNumber: line, linktext: 'meeting.m4a' });

describe('describeKept', () => {
	it('names every referencing note with an Open note action, and offers remove-and-delete when only notes block', () => {
		const card = describeKept(file, elig(['still-referenced'], { referrers: [noteRef('A.md'), noteRef('B.md', 9)], sameNameFiles: [], unreadable: [] }, 2), ctx());
		expect(card.entries.map((e) => e.item.type)).toEqual(['referenced', 'referenced']);
		expect(card.entries[0].actions).toEqual([{ kind: 'open-note', path: 'A.md' }]);
		expect(card.fileActions).toEqual([{ kind: 'remove-link-and-delete' }]);
	});

	it('offers a one-click enable instead when link removal is off, and nothing when unavailable', () => {
		const e = elig(['still-referenced'], { referrers: [noteRef('A.md')], sameNameFiles: [], unreadable: [] }, 1);
		expect(describeKept(file, e, ctx({ linkRemoval: 'off' })).fileActions).toEqual([{ kind: 'enable-link-removal' }]);
		expect(describeKept(file, e, ctx({ linkRemoval: 'unavailable' })).fileActions).toEqual([]);
	});

	it('offers nothing and says why when the links cannot be removed automatically', () => {
		const e = elig(['still-referenced'], { referrers: [noteRef('A.md')], sameNameFiles: [], unreadable: [] }, 1);
		const on = describeKept(file, e, ctx(), { linksRemovable: false });
		expect(on.fileActions).toEqual([]);
		expect(on.notes).toEqual(['links-not-removable']);
		const off = describeKept(file, e, ctx({ linkRemoval: 'off' }), { linksRemovable: false });
		expect(off.fileActions).toEqual([]);
		expect(off.notes).toEqual(['links-not-removable']);
		// removal unavailable on this host: nothing to explain either
		expect(describeKept(file, e, ctx({ linkRemoval: 'unavailable' }), { linksRemovable: false }).notes).toEqual([]);
	});

	it('an unchecked or removable card behaves as before and carries no note', () => {
		const e = elig(['still-referenced'], { referrers: [noteRef('A.md')], sameNameFiles: [], unreadable: [] }, 1);
		for (const opts of [{}, { linksRemovable: true }, { linksRemovable: undefined }]) {
			const card = describeKept(file, e, ctx(), opts);
			expect(card.fileActions).toEqual([{ kind: 'remove-link-and-delete' }]);
			expect(card.notes).toEqual([]);
		}
	});

	it('never offers removal for a canvas referrer (open it instead)', () => {
		const card = describeKept(file, elig(['still-referenced'], { referrers: [{ path: 'Board.canvas', extension: 'canvas', lineNumber: 0, linktext: 'x' }], sameNameFiles: [], unreadable: [] }, 1), ctx());
		expect(card.entries[0].actions).toEqual([{ kind: 'open-canvas', path: 'Board.canvas' }]);
		expect(card.fileActions).toEqual([]);
	});

	it('never offers removal when a referencing note is in a protected folder, and says it is protected', () => {
		const card = describeKept(file, elig(['still-referenced'], { referrers: [noteRef('Locked/A.md')], sameNameFiles: [], unreadable: [] }, 1), ctx({ protectedFolders: ['Locked'] }));
		expect(card.entries[0].item).toMatchObject({ type: 'referenced', protectedReferrer: true });
		expect(card.fileActions).toEqual([]);
	});

	it('does not offer removal when another reason also blocks (ambiguity, unreadable, changed)', () => {
		const blockers = { referrers: [noteRef('A.md')], sameNameFiles: ['Archive/meeting.m4a'], unreadable: [] };
		expect(describeKept(file, elig(['still-referenced', 'ambiguous-reference'], blockers, 1), ctx()).fileActions).toEqual([]);
		expect(describeKept(file, elig(['still-referenced', 'file-changed'], blockers, 1), ctx()).fileActions).toEqual([{ kind: 'scan-again' }]);
	});

	it('names the other file of an ambiguous link with an Open file action', () => {
		const card = describeKept(file, elig(['ambiguous-reference'], { referrers: [], sameNameFiles: ['Archive/meeting.m4a'], unreadable: [] }), ctx());
		expect(card.entries).toEqual([{ item: { type: 'ambiguous', others: ['Archive/meeting.m4a'] }, actions: [{ kind: 'open-file', path: 'Archive/meeting.m4a' }] }]);
	});

	it('names the unreadable note or canvas, by kind', () => {
		const unreadable = [{ path: 'Broken.md', kind: 'markdown-unreadable' as const }, { path: 'Bad.canvas', kind: 'canvas-unreadable' as const }];
		const note = describeKept(file, elig(['scan-incomplete'], { referrers: [], sameNameFiles: [], unreadable }), ctx());
		expect(note.entries).toEqual([{ item: { type: 'unreadable', failure: unreadable[0] }, actions: [{ kind: 'open-note', path: 'Broken.md' }] }]);
		const canvas = describeKept(file, elig(['canvas-unreadable'], { referrers: [], sameNameFiles: [], unreadable }), ctx());
		expect(canvas.entries).toEqual([{ item: { type: 'unreadable', failure: unreadable[1] }, actions: [{ kind: 'open-canvas', path: 'Bad.canvas' }] }]);
	});

	it('offers Scan again once for a changed file, and nothing for missing or protected', () => {
		expect(describeKept(file, elig(['file-changed']), ctx()).fileActions).toEqual([{ kind: 'scan-again' }]);
		expect(describeKept(file, elig(['target-missing']), ctx()).entries[0].item.type).toBe('missing');
		expect(describeKept(file, elig(['protected-path']), ctx()).entries[0].item.type).toBe('protected');
	});

	it('still says something true when a reference is known but its source is not', () => {
		const card = describeKept(file, { eligible: false, reasons: ['still-referenced'], referenceCount: 2 }, ctx());
		expect(card.entries).toEqual([{ item: { type: 'referenced-unknown', count: 2 }, actions: [] }]);
		expect(card.fileActions).toEqual([]);
	});

	it('produces a card for every reason (no reason is silently dropped)', () => {
		const all: IneligibleReason[] = ['still-referenced', 'ambiguous-reference', 'canvas-unreadable', 'scan-incomplete', 'file-changed', 'target-missing', 'protected-path'];
		for (const reason of all) expect(describeKept(file, elig([reason]), ctx()).entries.length, reason).toBeGreaterThan(0);
	});
});
