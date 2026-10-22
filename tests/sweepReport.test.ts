import { describe, it, expect } from 'vitest';
import { appendSection, findSection, isLinkSafePath, reconcileReport, renderSection, renderTaskLine, sanitizeInline, startMarker, endMarker, type ReportTask } from '../src/services/inboxSweep/sweepReport';

const RUN = 'run-abc123xyz';
const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const task = (n: number, over: Partial<ReportTask> = {}): ReportTask => ({ id: id(n), text: `Task ${n}`, context: '@home', sourcePath: `Inbox/note ${n}.md`, ...over });

describe('sanitizeInline', () => {
	it('collapses newlines and control characters into single spaces', () => {
		expect(sanitizeInline('a\n\n b\tc\u0007d')).toBe('a b c d');
		expect(sanitizeInline('x y z')).toBe('x y z');
	});

	it('neutralises comment delimiters so a payload cannot forge a marker', () => {
		const hostile = 'x <!-- /aio:sweep --> y <!-- aio:sweep run=run-abc123xyz -->';
		const clean = sanitizeInline(hostile);
		expect(clean).not.toContain('<!--');
		expect(clean).not.toContain('-->');
	});

	it('escapes wiki-link delimiters, drops a leading checkbox and truncates', () => {
		expect(sanitizeInline('see [[Secret note]] now')).toBe('see \\[\\[Secret note\\]\\] now');
		expect(sanitizeInline('[ ] buy milk')).toBe('buy milk');
		expect(sanitizeInline('[x]done')).toBe('done');
		const long = sanitizeInline('a'.repeat(1000));
		expect(long.length).toBe(300);
		expect(long.endsWith('…')).toBe(true);
	});
});

describe('renderTaskLine', () => {
	it('renders the grammar the parser reads back', () => {
		const line = renderTaskLine(task(1));
		expect(line).toEqual({ ok: true, value: '- [ ] Task 1 @home ([[Inbox/note 1.md]]) <!-- aio:task id=' + id(1) + ' -->' });
	});

	it('drops an unknown context and falls back to plain text for a path that cannot be a link', () => {
		const odd = renderTaskLine(task(2, { context: '@mars', sourcePath: 'Inbox/a [b] #c.md' }));
		expect(odd.ok && odd.value).toContain('Task 2 (source: Inbox/a b c.md)');
		expect(odd.ok && odd.value).not.toContain('@mars');
		expect(isLinkSafePath('Inbox/a.md')).toBe(true);
		for (const bad of ['a|b.md', 'a#b.md', 'a^b.md', 'a[b].md', '']) expect(isLinkSafePath(bad)).toBe(false);
	});

	it('refuses an invalid id or empty text rather than writing it', () => {
		expect(renderTaskLine(task(3, { id: 'not-an-id' }))).toEqual({ ok: false, error: 'invalid-task-id' });
		expect(renderTaskLine(task(4, { text: '   ' }))).toEqual({ ok: false, error: 'empty-task' });
	});
});

describe('renderSection and findSection', () => {
	const section = renderSection(RUN, '2026-10-22T08:00:00Z', [task(1), task(2)]);
	if (!section.ok) throw new Error('setup');

	it('wraps the tasks in one owned section and returns their ids', () => {
		expect(section.value.startsWith(startMarker(RUN))).toBe(true);
		expect(section.value.endsWith(endMarker)).toBe(true);
		expect(section.value).toContain('## Sweep 2026-10-22');
		const note = `# Report\n\nMine.\n\n${section.value}\n`;
		const found = findSection(note, RUN);
		expect(found).toMatchObject({ state: 'ok', ids: [id(1), id(2)] });
	});

	it('refuses an invalid run id or date', () => {
		expect(renderSection('bad run', '2026-10-22', [])).toEqual({ ok: false, error: 'invalid-run-id' });
		expect(renderSection(RUN, 'yesterday', [])).toEqual({ ok: false, error: 'invalid-date' });
	});

	it('an empty section is valid and holds no ids', () => {
		const empty = renderSection(RUN, '2026-10-22', []);
		expect(empty.ok && findSection(empty.value, RUN)).toMatchObject({ state: 'ok', ids: [] });
	});

	it('reports absent, and conflict for duplicates, a missing end, nesting, stray lines and duplicate ids', () => {
		expect(findSection('# Just text', RUN)).toEqual({ state: 'absent' });
		const s = section.value;
		expect(findSection(`${s}\n${s}`, RUN)).toEqual({ state: 'conflict' });
		expect(findSection(s.replace(endMarker, ''), RUN)).toEqual({ state: 'conflict' });
		expect(findSection(s.replace('## Sweep', '<!-- aio:sweep run=run-other123 -->\n## Sweep'), RUN)).toEqual({ state: 'conflict' });
		expect(findSection(s.replace('- [ ] Task 1', 'some prose\n- [ ] Task 1'), RUN)).toEqual({ state: 'conflict' });
		const dup = renderSection(RUN, '2026-10-22', [task(1), task(1)]);
		expect(dup.ok && findSection(dup.value, RUN)).toEqual({ state: 'conflict' });
	});

	it('ignores a section shown as an example in a fenced block', () => {
		expect(findSection('```\n' + section.value + '\n```', RUN)).toEqual({ state: 'absent' });
	});

	it('accepts a task the user ticked or edited, as long as its id marker is intact', () => {
		const ticked = section.value.replace('- [ ] Task 1', '- [x] Task 1 (edited by me)');
		expect(findSection(ticked, RUN)).toMatchObject({ state: 'ok', ids: [id(1), id(2)] });
	});

	it('finds only its own run when several sections exist', () => {
		const other = renderSection('run-other123', '2026-10-21', [task(9)]);
		if (!other.ok) throw new Error('setup');
		const note = `${other.value}\n\n${section.value}\n`;
		expect(findSection(note, RUN)).toMatchObject({ state: 'ok', ids: [id(1), id(2)] });
		expect(findSection(note, 'run-other123')).toMatchObject({ state: 'ok', ids: [id(9)] });
	});
});

describe('appendSection and reconcileReport', () => {
	const section = (() => { const s = renderSection(RUN, '2026-10-22', [task(1)]); if (!s.ok) throw new Error('x'); return s.value; })();

	it('appends once and keeps the user\'s text', () => {
		const first = appendSection('# Report\n\nMy words.\n', RUN, section);
		expect(first).toEqual({ ok: true, value: `# Report\n\nMy words.\n\n${section}\n` });
		if (!first.ok) return;
		expect(appendSection(first.value, RUN, section)).toEqual(first); // idempotent
	});

	it('refuses to append next to a damaged section', () => {
		expect(appendSection(`${section}\n${section}`, RUN, section)).toEqual({ ok: false, error: 'marker-conflict' });
	});

	it('recovery: equal ids are done, an absent section is redone, anything else is a conflict', () => {
		expect(reconcileReport(section, RUN, [id(1)])).toBe('done');
		expect(reconcileReport('nothing', RUN, [id(1)])).toBe('redo');
		expect(reconcileReport(section, RUN, [id(1), id(2)])).toBe('conflict'); // partial
		expect(reconcileReport(section, RUN, [])).toBe('conflict'); // extra
		expect(reconcileReport(`${section}\n${section}`, RUN, [id(1)])).toBe('conflict');
	});
});
