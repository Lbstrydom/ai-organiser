import { describe, it, expect } from 'vitest';
import {
	applyDispositions, applyExportResults, exportable, isComplete, isSwept, markReported, newApproval, pendingApprovals,
	pruneApprovals, renameApprovals, renameLedger, type ApprovalRecord, type SweepLedger,
} from '../src/services/inboxSweep/sweepLedger';

const task = (n: number, over: Record<string, unknown> = {}) => ({ id: `aio-${n}`, text: `T${n}`, context: '', sourcePath: `Inbox/n${n}.md`, sourceHash: `h${n}`, ...over });
const base = (over: Partial<Parameters<typeof newApproval>[0]> = {}): ApprovalRecord =>
	newApproval({ runId: 'run-1', now: 'T', reportPath: 'Reports/sweep.md', tasks: [task(1), task(2)], dispositions: [{ sourcePath: 'Inbox/n1.md', sourceHash: 'h1', markSwept: true }, { sourcePath: 'Inbox/n2.md', sourceHash: 'h2', markSwept: false }], ...over });

describe('ledger', () => {
	it('knows a note is swept only at the hash it was swept at', () => {
		const ledger: SweepLedger = { 'Inbox/a.md': { sha256: 'h', sweptAt: 'T', runId: 'r' } };
		expect(isSwept(ledger, 'Inbox/a.md', 'h')).toBe(true);
		expect(isSwept(ledger, 'Inbox/a.md', 'changed')).toBe(false);
		expect(isSwept(ledger, 'Inbox/b.md', 'h')).toBe(false);
	});

	it('applies exactly the user\'s dispositions, independent of the approved tasks', () => {
		const record = base({ tasks: [], dispositions: [{ sourcePath: 'Inbox/x.md', sourceHash: 'hx', markSwept: true }, { sourcePath: 'Inbox/y.md', sourceHash: 'hy', markSwept: false }] });
		const next = applyDispositions({}, record, 'NOW');
		expect(next).toEqual({ 'Inbox/x.md': { sha256: 'hx', sweptAt: 'NOW', runId: 'run-1' } });
	});

	it('a record with zero tasks has nothing to report and starts with the report step done', () => {
		expect(base({ tasks: [] }).reportDone).toBe(true);
		expect(base().reportDone).toBe(false);
	});
});

describe('approval states', () => {
	it('moves approved -> reported -> exported and only reported items are exportable', () => {
		const rec = base();
		expect(exportable(rec)).toEqual([]);
		const reported = markReported(rec);
		expect(reported.reportDone).toBe(true);
		expect(exportable(reported).map((t) => t.id)).toEqual(['aio-1', 'aio-2']);
		const exported = applyExportResults(reported, [{ exportId: 'aio-1', status: 'created' }, { exportId: 'aio-2', status: 'exists' }]);
		expect(exported.tasks.map((t) => t.state)).toEqual(['exported', 'exported']);
		expect(exportable(exported)).toEqual([]);
	});

	it('retry leaves an item as it was, error records a retryable failure, conflict is final', () => {
		const reported = markReported(base());
		const after = applyExportResults(reported, [{ exportId: 'aio-1', status: 'retry' }, { exportId: 'aio-2', status: 'error' }]);
		expect(after.tasks.map((t) => t.state)).toEqual(['reported', 'failed']);
		expect(exportable(after).map((t) => t.id)).toEqual(['aio-1', 'aio-2']);
		const conflict = applyExportResults(reported, [{ exportId: 'aio-2', status: 'conflict' }]);
		expect(exportable(conflict).map((t) => t.id)).toEqual(['aio-1']);
	});

	it('ignores results for ids it does not know', () => {
		const reported = markReported(base());
		expect(applyExportResults(reported, [{ exportId: 'aio-zzz', status: 'created' }])).toEqual(reported);
	});

	it('is complete only when report, ledger and every task are settled', () => {
		let rec = markReported(base());
		expect(isComplete(rec)).toBe(false);
		rec = applyExportResults(rec, [{ exportId: 'aio-1', status: 'created' }, { exportId: 'aio-2', status: 'created' }]);
		expect(isComplete(rec)).toBe(false); // ledger not applied yet
		expect(isComplete({ ...rec, ledgerDone: true })).toBe(true);
	});

	it('lists records with work left and prunes only finished ones', () => {
		const done: ApprovalRecord = { ...markReported(base({ tasks: [] })), ledgerDone: true, runId: 'run-done', createdAt: '1' };
		const open = base();
		expect(pendingApprovals([done, open], true)).toEqual([open]);
		const waiting = { ...markReported(base()), ledgerDone: true };
		expect(pendingApprovals([waiting], true)).toEqual([waiting]);
		expect(pendingApprovals([waiting], false)).toEqual([]); // export switched off: nothing waits
		const many = Array.from({ length: 30 }, (_, i) => ({ ...done, runId: `run-${i}`, createdAt: String(i).padStart(3, '0') }));
		const kept = pruneApprovals([open, ...many], 5);
		expect(kept).toHaveLength(6);
		expect(kept[0]).toBe(open);
	});
});

describe('renames', () => {
	it('moves ledger keys for a file and for a folder, and leaves siblings that share a prefix', () => {
		const ledger: SweepLedger = {
			'Inbox/a.md': { sha256: '1', sweptAt: 'T', runId: 'r' },
			'Inbox/sub/b.md': { sha256: '2', sweptAt: 'T', runId: 'r' },
			'InboxExtra/c.md': { sha256: '3', sweptAt: 'T', runId: 'r' },
		};
		const file = renameLedger(ledger, 'Inbox/a.md', 'Done/a.md');
		expect(Object.keys(file.ledger).sort()).toEqual(['Done/a.md', 'Inbox/sub/b.md', 'InboxExtra/c.md']);
		const folder = renameLedger(ledger, 'Inbox', 'Archive/Inbox');
		expect(Object.keys(folder.ledger).sort()).toEqual(['Archive/Inbox/a.md', 'Archive/Inbox/sub/b.md', 'InboxExtra/c.md']);
		expect(renameLedger(ledger, 'Nothing', 'Else').changed).toBe(false);
	});

	it('moves source paths, dispositions and the report path inside open records', () => {
		const rec = base();
		const out = renameApprovals([rec], 'Inbox', 'Archive');
		expect(out.changed).toBe(true);
		expect(out.records[0].tasks[0].sourcePath).toBe('Archive/n1.md');
		expect(out.records[0].dispositions[0].sourcePath).toBe('Archive/n1.md');
		expect(out.records[0].reportPath).toBe('Reports/sweep.md');
		const report = renameApprovals([rec], 'Reports', 'Notes/Reports');
		expect(report.records[0].reportPath).toBe('Notes/Reports/sweep.md');
	});
});
