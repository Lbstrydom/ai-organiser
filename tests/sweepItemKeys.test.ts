/**
 * Item identity for the sweep: normalisation, quote|wording keys, the exact / similar match, legacy keys.
 */
import { describe, it, expect } from 'vitest';
import { dropAlreadyReported, isReportedItem, itemKeys, legacyTaskKeys, normaliseItemText, reportedMatch } from '../src/services/inboxSweep/sweepItemIdentity';
import { record } from './helpers/sweepReofferFixtures';

describe('item identity keys', () => {
	it('normalise case, punctuation and spacing', () => {
		expect(normaliseItemText('  Call   the plumber!! (Thursday) ')).toBe('call the plumber thursday');
		expect(normaliseItemText('É déjà vu')).toBe('é déjà vu');
	});

	it('are quote|wording pairs, one per wording (model and edited)', () => {
		const keys = itemKeys({ text: 'Draft the migration plan', evidence: 'I need to draft the migration plan', edited: 'Draft migration plan v2' });
		expect(keys).toEqual(['i need to draft the migration plan|draft the migration plan', 'i need to draft the migration plan|draft migration plan v2']);
	});

	it('an edited text equal to the model text adds no duplicate key, and empty wordings are dropped', () => {
		expect(itemKeys({ text: 'A b', evidence: 'x y', edited: 'a b' })).toEqual(['x y|a b']);
		expect(itemKeys({ text: '   ', evidence: '  ' })).toEqual([]);
	});

	it('long texts keep their whole identity (no shared-prefix collapse at 160 characters)', () => {
		const prefix = 'prepare the quarterly review pack for the board including '.repeat(4);
		const a = itemKeys({ text: prefix + 'revenue', evidence: 'q' });
		const b = itemKeys({ text: prefix + 'headcount', evidence: 'q2' });
		expect(prefix.length).toBeGreaterThan(160);
		expect(isReportedItem(new Set(a), b)).toBe(false);
		expect(isReportedItem(new Set(a), a)).toBe(true);
	});
});

describe('titles without letters or digits', () => {
	it('keep an identity: the symbols themselves', () => {
		expect(normaliseItemText('📞')).toBe('📞');
		const first = new Set(itemKeys({ text: '📞', evidence: 'q' }));
		expect(isReportedItem(first, itemKeys({ text: '📞', evidence: 'other' }))).toBe(true);
		expect(isReportedItem(first, itemKeys({ text: '🚗', evidence: 'q' }))).toBe(false);
		expect(legacyTaskKeys('📞')).toEqual(['|📞']);
	});

	it('never contain the key separator, so a key always splits where it was joined', () => {
		expect(normaliseItemText('📞|🚗')).toBe('📞 🚗');
		const keys = itemKeys({ text: '📞|🚗', evidence: '🚗|📞' });
		expect(keys).toEqual(['🚗 📞|📞 🚗']);
		expect(isReportedItem(new Set(keys), keys)).toBe(true);
		expect(isReportedItem(new Set(keys), itemKeys({ text: '📞', evidence: '🚗 📞' }))).toBe(false);
	});

	it('a second symbol-only task from the same note is blocked at the commit, keys or not', () => {
		const rec = record([{ n: 1, text: '📞' }]);
		const out = dropAlreadyReported([{ sourcePath: 'Inbox/a.md', text: '📞' }], {}, [rec]);
		expect(out.dropped).toBe(1);
	});
});

describe('normalisation length', () => {
	it('text that NFKC lengthens keeps its identity (the cap is on the text as written)', () => {
		const ligatures = 'ﬃ'.repeat(200); // 200 characters written, 600 after NFKC
		const a = itemKeys({ text: `${ligatures}a`, evidence: 'q' });
		const b = itemKeys({ text: `${ligatures}b`, evidence: 'q' });
		expect(normaliseItemText(`${ligatures}a`).length).toBeGreaterThan(400);
		expect(isReportedItem(new Set(a), b)).toBe(false);
		expect(isReportedItem(new Set(a), a)).toBe(true);
	});
});

describe('isReportedItem', () => {
	const known = new Set(itemKeys({ text: 'Draft the migration plan', evidence: 'I need to draft the migration plan' }));

	it('same wording matches whatever the quote', () => {
		expect(isReportedItem(known, itemKeys({ text: 'Draft the migration plan!', evidence: 'something else' }))).toBe(true);
	});

	it('the same quote with reworded but similar text is only "similar": flagged for the user, never enforced', () => {
		const reworded = itemKeys({ text: 'Write the migration plan', evidence: 'I need to draft the migration plan' });
		expect(reportedMatch(known, reworded)).toBe('similar');
		expect(isReportedItem(known, reworded)).toBe(false);
	});

	it('two commitments from one sentence are never "exact", even when their wording overlaps', () => {
		const both = 'Send the invoice to Alice and send the invoice to Bob';
		const first = new Set(itemKeys({ text: 'Send the invoice to Alice', evidence: both }));
		const second = itemKeys({ text: 'Send the invoice to Bob', evidence: both });
		expect(isReportedItem(first, second)).toBe(false); // never silently blocked
		expect(reportedMatch(first, second)).toBe('similar'); // but the user is told
		expect(reportedMatch(first, itemKeys({ text: 'Book the venue', evidence: both }))).toBeNull();
		expect(reportedMatch(first, itemKeys({ text: 'Send the invoice to Alice', evidence: both }))).toBe('exact');
	});

	it('a different quote with different wording does not match, and nothing known means nothing matches', () => {
		expect(isReportedItem(known, itemKeys({ text: 'Book the venue', evidence: 'book the venue' }))).toBe(false);
		expect(isReportedItem(new Set(), itemKeys({ text: 'x y', evidence: 'x y' }))).toBe(false);
	});
});

describe('legacy keys (tasks reported before keys existed)', () => {
	it('are wording-only and drop the kind prefix and a trailing (who)', () => {
		expect(legacyTaskKeys('Waiting: Priya to send the revised SOW (Priya)')).toEqual(['|priya to send the revised sow priya', '|priya to send the revised sow']);
		expect(legacyTaskKeys('Someday: Look at a data catalogue tool')).toEqual(['|look at a data catalogue tool']);
		expect(legacyTaskKeys('Draft the migration plan')).toEqual(['|draft the migration plan']);
	});

	it('keep a parenthesis the user wrote; only a waiting-for item can have had "(who)" appended', () => {
		expect(legacyTaskKeys('Call Dana (re budget)')).toEqual(['|call dana re budget']);
		expect(legacyTaskKeys('Project: Move house (phase 2)')).toEqual(['|move house phase 2']);
	});
});

