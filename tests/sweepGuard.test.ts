import { describe, it, expect } from 'vitest';
import { exclusionReason, guardSnapshot, policyRevisionOf, stillAllowed, type SweepPolicy } from '../src/services/inboxSweep/sweepGuard';
import { buildSnapshot, parseSnapshotMetadata } from '../src/services/inboxSweep/noteSnapshot';

const policy = (over: Partial<SweepPolicy> = {}): SweepPolicy => ({
	excludedFolders: [],
	excludedTags: [],
	excludedProperties: [],
	excludedTerms: [],
	protectedFolders: [],
	maxNoteChars: 20_000,
	...over,
});

describe('exclusionReason', () => {
	it('allows an ordinary note when nothing is excluded', () => {
		expect(exclusionReason('Inbox/a.md', 'Call the plumber tomorrow.', policy())).toBeNull();
	});

	it('excludes by folder (prefix-safe) and by protected folder', () => {
		expect(exclusionReason('Private/a.md', 'x', policy({ excludedFolders: ['Private'] }))).toBe('folder');
		expect(exclusionReason('PrivateExtra/a.md', 'x', policy({ excludedFolders: ['Private'] }))).toBeNull();
		expect(exclusionReason('Course/a.md', 'x', policy({ protectedFolders: ['Course'] }))).toBe('protected');
	});

	it('excludes by tag, including nested tags, frontmatter and inline', () => {
		const p = policy({ excludedTags: ['#work'] });
		expect(exclusionReason('a.md', '---\ntags: [work]\n---\nbody', p)).toBe('tag');
		expect(exclusionReason('a.md', 'note #work/projectx here', p)).toBe('tag');
		expect(exclusionReason('a.md', 'note #homework here', p)).toBeNull();
		expect(exclusionReason('a.md', '---\ntags: "Work, other"\n---\nbody', p)).toBe('tag');
	});

	it('excludes by property pair, case-insensitively, including list values', () => {
		const p = policy({ excludedProperties: ['client: Acme'] });
		expect(exclusionReason('a.md', '---\nclient: acme\n---\nbody', p)).toBe('property');
		expect(exclusionReason('a.md', '---\nClient: [Acme, Other]\n---\nbody', p)).toBe('property');
		expect(exclusionReason('a.md', '---\nclient: Other\n---\nbody', p)).toBeNull();
		expect(exclusionReason('a.md', '---\nclient: Acme Corp\n---\nbody', p)).toBeNull(); // exact value, not a substring
	});

	it('excludes by term anywhere in the full text', () => {
		const p = policy({ excludedTerms: ['Project Falcon'] });
		expect(exclusionReason('a.md', 'x'.repeat(5000) + ' about project falcon ' + 'y'.repeat(5000), p)).toBe('term');
		expect(exclusionReason('a.md', 'Falcon alone', p)).toBeNull();
	});

	it('fails closed on anything unknown', () => {
		expect(exclusionReason('', 'x', policy())).toBe('unknown');
		expect(exclusionReason('a.md', undefined, policy())).toBe('unknown');
		expect(exclusionReason('a.md', 42 as never, policy())).toBe('unknown');
		expect(exclusionReason('a.md', 'x'.repeat(30_000), policy())).toBe('too-large');
		expect(exclusionReason('a.md', 'x', policy({ maxNoteChars: 0 }))).toBe('too-large');
		expect(exclusionReason('a.md', 'x', policy({ maxNoteChars: NaN }))).toBe('too-large');
		expect(exclusionReason('a.md', '---\nkey: [unclosed\n---\nbody', policy())).toBe('unreadable');
	});

	it('ignores malformed exclusion entries instead of treating them as a match', () => {
		const p = policy({ excludedProperties: ['no-colon', ': empty', 'key:'], excludedTerms: ['', '   '], excludedTags: ['', '#'] });
		expect(exclusionReason('a.md', 'plain note', p)).toBeNull();
	});
});

describe('guardSnapshot and revisions', () => {
	it('allows a snapshot captured under the current policy and brands it', async () => {
		const p = policy();
		const rev = await policyRevisionOf(p);
		const snap = await buildSnapshot('Inbox/a.md', 'Do the thing.', rev);
		const res = guardSnapshot(snap, p, rev);
		expect(res.allowed).toBe(true);
		if (res.allowed) expect(res.snapshot.path).toBe('Inbox/a.md');
	});

	it('refuses a snapshot judged against a different policy revision', async () => {
		const snap = await buildSnapshot('Inbox/a.md', 'Do the thing.', await policyRevisionOf(policy()));
		const later = policy({ excludedTerms: ['thing'] });
		expect(guardSnapshot(snap, later, await policyRevisionOf(later))).toEqual({ allowed: false, reason: 'unknown' });
	});

	it('the revision changes with every setting that matters and not with their order', async () => {
		const base = await policyRevisionOf(policy({ excludedTags: ['a', 'b'] }));
		expect(await policyRevisionOf(policy({ excludedTags: ['b', 'a'] }))).toBe(base);
		for (const changed of [
			policy({ excludedFolders: ['X'] }), policy({ excludedTags: ['a', 'b', 'c'] }), policy({ excludedProperties: ['k: v'] }),
			policy({ excludedTerms: ['t'] }), policy({ protectedFolders: ['P'] }), policy({ maxNoteChars: 5 }),
		]) {
			expect(await policyRevisionOf(changed)).not.toBe(await policyRevisionOf(policy({ excludedTags: ['a', 'b'] })));
		}
	});

	it('stillAllowed catches a changed policy and a moved note', async () => {
		const p = policy();
		const rev = await policyRevisionOf(p);
		const res = guardSnapshot(await buildSnapshot('Inbox/a.md', 'Do the thing.', rev), p, rev);
		if (!res.allowed) throw new Error('setup');
		expect(stillAllowed(res.snapshot, p, rev, 'Inbox/a.md')).toBe(true);
		expect(stillAllowed(res.snapshot, p, rev, 'Elsewhere/a.md')).toBe(false);
		const stricter = policy({ excludedFolders: ['Inbox'] });
		expect(stillAllowed(res.snapshot, stricter, await policyRevisionOf(stricter), 'Inbox/a.md')).toBe(false);
	});
});

describe('fail-closed metadata', () => {
	const p = policy({ excludedTags: ['private'] });

	it('treats a frontmatter block that never closes as unreadable, so its tags cannot slip past', () => {
		expect(exclusionReason('a.md', '---\ntags: [private]\ntitle: x\nbody that never closes the block', p)).toBe('unreadable');
		expect(exclusionReason('a.md', '---\r\ntags: [private]\r\nno end', p)).toBe('unreadable');
		expect(exclusionReason('a.md', '--- not frontmatter\nplain', p)).toBeNull();
		expect(exclusionReason('a.md', 'Text\n---\nhorizontal rule only', p)).toBeNull();
	});

	it('treats metadata that expands past its budget as unreadable instead of hanging', () => {
		const bomb = ['---', 'a: &a [x, x, x, x, x, x, x, x, x, x]', 'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]', 'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]', 'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]', 'e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]', '---', 'body'].join('\n');
		const start = Date.now();
		expect(exclusionReason('a.md', bomb, policy())).toBe('unreadable');
		expect(Date.now() - start).toBeLessThan(2000);
		expect(parseSnapshotMetadata('---\nk: [' + Array.from({ length: 600 }, (_, i) => `v${i}`).join(',') + ']\n---\n').frontmatterOk).toBe(false);
	});

	it('looks up properties by their own keys only', () => {
		const props = policy({ excludedProperties: ['constructor: x', 'toString: y', '__proto__: z'] });
		expect(exclusionReason('a.md', '---\ntitle: ok\n---\nbody', props)).toBeNull();
		expect(exclusionReason('a.md', '---\nconstructor: x\n---\nbody', props)).toBe('property');
		expect(parseSnapshotMetadata('---\nconstructor: x\n---\n').properties.constructor).toEqual(['x']);
	});
});

describe('parseSnapshotMetadata', () => {
	it('reads tags and properties from the same text', () => {
		const m = parseSnapshotMetadata('---\ntags: [a, "#b"]\nclient: Acme\nlist: [x, y]\n---\nbody #inline');
		expect(m.tags.sort()).toEqual(['a', 'b', 'inline']);
		expect(m.properties.client).toEqual(['Acme']);
		expect(m.properties.list).toEqual(['x', 'y']);
		expect(m.frontmatterOk).toBe(true);
	});

	it('flags unreadable frontmatter instead of pretending there is none', () => {
		expect(parseSnapshotMetadata('---\n: : :\n  bad: [\n---\nx').frontmatterOk).toBe(false);
		expect(parseSnapshotMetadata('no frontmatter').frontmatterOk).toBe(true);
	});
});
