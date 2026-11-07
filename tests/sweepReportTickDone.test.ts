/**
 * The completion check ticks the sweep report line of a task done in Google: only that task's line, only in the body, never
 * unticking, and the once-only marker survives a settings round trip.
 */
import { describe, it, expect } from 'vitest';
import { tickDone, findSection } from '../src/services/inboxSweep/sweepReport';
import { migrateOldSettings } from '../src/core/settings';
import type { ApprovalRecord } from '../src/services/inboxSweep/sweepLedger';

const A = 'aio-11111111-1111-4111-8111-111111111111';
const B = 'aio-22222222-2222-4222-8222-222222222222';
const report = [
	'# Inbox sweep report',
	'',
	'<!-- aio:sweep run=run-abcdef -->',
	'## Sweep 2026-11-07',
	`- [ ] Call the dentist @call ([[0 Inbox/call dentist.md]]) <!-- aio:task id=${A} -->`,
	`- [ ] Waiting: Signed supplier contract ([[0 Inbox/a.md]]) <!-- aio:task id=${B} -->`,
	'<!-- /aio:sweep -->',
	'',
].join('\n');

describe('tickDone', () => {
	it('ticks only the lines of the given ids and keeps the section readable', () => {
		const out = tickDone(report, new Set([A]));
		expect(out.ticked).toBe(1);
		expect(out.found).toEqual([A]);
		expect(out.text).toContain(`- [x] Call the dentist @call ([[0 Inbox/call dentist.md]]) <!-- aio:task id=${A} -->`);
		expect(out.text).toContain(`- [ ] Waiting: Signed supplier contract`);
		expect(findSection(out.text, 'run-abcdef')).toMatchObject({ state: 'ok', ids: [A, B] });
	});

	it('leaves a line already ticked as it is, but reports it found', () => {
		const once = tickDone(report, new Set([A])).text;
		const twice = tickDone(once, new Set([A]));
		expect(twice.ticked).toBe(0);
		expect(twice.found).toEqual([A]);
		expect(twice.text).toBe(once);
	});

	it('never unticks, and changes nothing for an id that is not in the note', () => {
		const ticked = report.replace(`- [ ] Waiting`, `- [x] Waiting`);
		const out = tickDone(ticked, new Set(['aio-33333333-3333-4333-8333-333333333333']));
		expect(out.text).toBe(ticked);
		expect(out.found).toEqual([]);
	});

	it('ignores a matching line inside a code block', () => {
		const fenced = ['```', `- [ ] x ([[a.md]]) <!-- aio:task id=${A} -->`, '```'].join('\n');
		const out = tickDone(fenced, new Set([A]));
		expect(out.text).toBe(fenced);
		expect(out.ticked).toBe(0);
	});

	it('keeps Windows line endings', () => {
		const crlf = report.replace(/\n/g, '\r\n');
		const out = tickDone(crlf, new Set([A]));
		expect(out.ticked).toBe(1);
		expect(out.text).toBe(crlf.replace('- [ ] Call', '- [x] Call'));
	});
});

describe('reportTicked survives the settings migration', () => {
	it('keeps true and drops anything else', () => {
		const task = (extra: Record<string, unknown>) => ({ id: A, text: 'x', context: '', sourcePath: 'a.md', sourceHash: 'h', state: 'exported', ...extra });
		const out = migrateOldSettings({
			sweepApprovals: [{ runId: 'run-abcdef', createdAt: '2026-11-07', reportPath: 'r.md', dispositions: [], reportDone: true, ledgerDone: true, tasks: [task({ reportTicked: true }), task({ id: B, reportTicked: 'yes' })] }],
		}) as { sweepApprovals: ApprovalRecord[] };
		expect(out.sweepApprovals[0].tasks[0].reportTicked).toBe(true);
		expect(out.sweepApprovals[0].tasks[1].reportTicked).toBeUndefined();
	});
});
