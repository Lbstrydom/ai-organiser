import { describe, it, expect } from 'vitest';
import { buildChatExport, CHAT_EXPORT_MARKER, CHAT_EXPORT_MAX_LINE_BYTES, CHAT_EXPORT_NAME_PATTERN, CHAT_EXPORT_PART_BYTES, isOwnExport } from '../src/services/agentConnectors/chatExport';
import { canonicalScopeJson, includedRecords, type ProjectionScope, type RawRecord } from '../src/services/agentIndex/agentIndexProjection';
import { isInIndexScope, projectionScope, scopeConfigFromSettings, type IndexScopeConfig } from '../src/services/agentIndex/agentIndexService';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const config: IndexScopeConfig = { includeFolders: [], excludeFolders: ['Private'], includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false };
const scope: ProjectionScope = projectionScope(config);

const rec = (path: string, over: Partial<RawRecord> = {}): RawRecord => ({
	path, basename: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''), folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
	tags: [], mtime: 1, size: 10, sha256: 'a'.repeat(64), links: [], aliases: [], headings: [], frontmatter: {}, ...over,
});

const records: RawRecord[] = [
	rec('Notes/Garden.md', { tags: ['plants', 'home'], links: [{ target: 'Notes/Soil.md', text: 'Soil' }, { target: 'Private/Diary.md', text: 'Diary' }, { target: null, text: 'Ghost' }] }),
	rec('Notes/Soil.md'),
	rec('Private/Diary.md', { tags: ['secret'] }),
	rec('.hidden/x.md'),
];

describe('buildChatExport', () => {
	const run = (recs = records, sc = scope) => buildChatExport({ records: recs, scope: sc, instructions: '## Finding notes in this vault\n', generatedAt: '2026-01-01T00:00:00.000Z' });

	it('lists exactly the notes the index would list, and never an excluded or hidden one', () => {
		const out = run();
		const listed = includedRecords(records, scope).map((r) => r.path);
		expect(listed).toEqual(['Notes/Garden.md', 'Notes/Soil.md']);
		expect(out.notes).toBe(2);
		const text = out.parts[0].text;
		for (const path of listed) expect(text).toContain(`- ${path}`);
		expect(text).not.toContain('Diary');
		expect(text).not.toContain('secret');
		expect(text).not.toContain('.hidden');
		expect(text).not.toContain('Ghost'); // unresolved links stay out unless the index setting exports them
		expect(text).toContain('links to excluded notes: [excluded]');
	});

	describe('protected folders', () => {
		const settings = { ...DEFAULT_SETTINGS, protectedFolders: ['Course'] } as never;
		const protectedScope = projectionScope(scopeConfigFromSettings(settings));
		const course = [
			rec('Course/Lecture 1.md', { tags: ['exam'] }),
			rec('Notes/Study plan.md', { links: [{ target: 'Course/Lecture 1.md', text: 'L1' }, { target: 'Notes/Soil.md', text: 'Soil' }] }),
			rec('Notes/Soil.md', { tags: ['plants'] }),
		];
		const exportWith = (sc: ProjectionScope) => buildChatExport({ records: course, scope: sc, instructions: '', generatedAt: 't' });

		it('leaves a protected note out, with its tags and every link to it', () => {
			const out = exportWith(protectedScope);
			const text = out.parts[0].text;
			expect(out.notes).toBe(2);
			expect(text).not.toContain('Lecture 1');
			expect(text).not.toContain('exam');
			expect(text).toContain('- Notes/Soil.md | tags: plants');
			expect(text).toContain('links: Notes/Soil.md | links to excluded notes: [excluded]');
		});

		it('still lists the same note when nothing is protected', () => {
			const out = exportWith(projectionScope(scopeConfigFromSettings({ ...DEFAULT_SETTINGS, protectedFolders: [] } as never)));
			expect(out.notes).toBe(3);
			expect(out.parts[0].text).toContain('- Course/Lecture 1.md | tags: exam');
		});

		it('is the same decision the index and the connector scope make', () => {
			const cfg = scopeConfigFromSettings(settings);
			expect(isInIndexScope('Course/Lecture 1.md', cfg)).toBe(false);
			expect(isInIndexScope('course/Deep/x.md', cfg)).toBe(false);
			expect(isInIndexScope('Courseware/x.md', cfg)).toBe(true);
			expect(isInIndexScope('Notes/Soil.md', cfg)).toBe(true);
			expect(canonicalScopeJson(cfg)).not.toBe(canonicalScopeJson(scopeConfigFromSettings({ ...DEFAULT_SETTINGS, protectedFolders: [] } as never)));
		});

		it('keeps the scope hash of a vault with no protected folders unchanged', () => {
			const none = scopeConfigFromSettings({ ...DEFAULT_SETTINGS, protectedFolders: [] } as never);
			expect(canonicalScopeJson(none)).toBe(canonicalScopeJson({ ...none, protectedFolders: undefined }));
			expect(canonicalScopeJson(none)).not.toContain('protectedFolders');
		});
	});

	it('uses the same scope function as the index for a table of paths', () => {
		const paths = ['A.md', 'Private/B.md', 'Private', 'private/C.md', '.x/D.md', 'Notes/.y/E.md', 'Notes/F.md'];
		const recs = paths.map((p) => rec(p));
		const exported = buildChatExport({ records: recs, scope, instructions: '', generatedAt: 't' }).parts.flatMap((p) => p.text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' | ')[0]));
		expect(exported.sort()).toEqual(paths.filter((p) => isInIndexScope(p, config)).sort());
	});

	it('is deterministic and byte-stable', () => {
		expect(run().parts[0].text).toBe(run([...records].reverse()).parts[0].text);
		expect(run().parts[0].text.startsWith(`${CHAT_EXPORT_MARKER}\n# Vault map\n`)).toBe(true);
		expect(run().parts[0].name).toBe('AI Organiser vault map.md');
	});

	it('contains no note body: only paths, tags and link targets', () => {
		const text = run().parts[0].text;
		expect(text).toContain('- Notes/Garden.md | tags: home, plants | links: Notes/Soil.md | links to excluded notes: [excluded]');
	});

	it('keeps free text on one line and cannot break out of its row', () => {
		const evil = rec('Notes/A | b\nc.md', { tags: ['x\n- Private/Secret.md'] });
		const text = run([evil]).parts[0].text;
		const rows = text.split('\n').filter((l) => l.startsWith('- '));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain('Notes/A \\| b c.md');
	});

	it('returns no parts when nothing is in scope', () => {
		expect(run([rec('Private/Only.md')])).toEqual({ parts: [], notes: 0 });
		expect(run([])).toEqual({ parts: [], notes: 0 });
	});

	it('splits a large vault into numbered parts that each stay near the part size and list every note once', () => {
		const many = Array.from({ length: 12_000 }, (_, i) => rec(`Notes/Note ${String(i).padStart(5, '0')} with a reasonably long title.md`, { tags: ['alpha', 'beta'] }));
		const out = run(many);
		expect(out.parts.length).toBeGreaterThan(1);
		expect(out.parts[0].name).toBe(`AI Organiser vault map (part 1 of ${out.parts.length}).md`);
		for (const part of out.parts) {
			expect(CHAT_EXPORT_NAME_PATTERN.test(part.name)).toBe(true);
			expect(new TextEncoder().encode(part.text).length).toBeLessThanOrEqual(CHAT_EXPORT_PART_BYTES);
			expect(isOwnExport(part.text)).toBe(true);
		}
		const rows = out.parts.flatMap((p) => p.text.split('\n').filter((l) => l.startsWith('- ')));
		expect(rows).toHaveLength(12_000);
		expect(new Set(rows).size).toBe(12_000);
		expect(out.parts[1].text).not.toContain('## Finding notes'); // the instructions travel once, in part 1
	});

	it('cuts one huge record at a character boundary so it can never push a part over its size', () => {
		const huge = rec('Notes/Huge.md', { tags: Array.from({ length: 3000 }, (_, i) => `tag-é-${i}`) });
		const out = run([huge, rec('Notes/Small.md')]);
		const rows = out.parts.flatMap((p) => p.text.split('\n').filter((l) => l.startsWith('- Notes/')));
		expect(rows).toHaveLength(2);
		const hugeRow = rows.find((r) => r.startsWith('- Notes/Huge.md'))!;
		expect(new TextEncoder().encode(hugeRow).length).toBeLessThanOrEqual(CHAT_EXPORT_MAX_LINE_BYTES);
		expect(hugeRow.endsWith('…')).toBe(true);
		expect(hugeRow).not.toContain('�'); // never cut inside a multi-byte character
	});

	it('recognises only its own files', () => {
		expect(isOwnExport(`${CHAT_EXPORT_MARKER}\nbody`)).toBe(true);
		expect(isOwnExport('# My own notes\n')).toBe(false);
		expect(CHAT_EXPORT_NAME_PATTERN.test('AI Organiser vault map.md')).toBe(true);
		expect(CHAT_EXPORT_NAME_PATTERN.test('AI Organiser vault map notes.md')).toBe(false);
	});
});
