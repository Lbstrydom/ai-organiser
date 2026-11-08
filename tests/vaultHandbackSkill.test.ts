/**
 * Drift guard for the hand-written `vault-handback` skill (docs/skills/vault-handback/SKILL.md). Its grammar block must be
 * the plugin's own `renderHandoffContract`, and every example it shows must pass through the real hand-back parser, the
 * sweep guard and the capture text-first rules exactly as the skill says it will. Edit the parser or the skill and this
 * fails until the two agree again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHandoffContract, HANDOFF_SECTIONS } from '../src/services/aiWorkspaces/handoffGrammar';
import { looksLikeHandback, parseHandoff } from '../src/services/aiWorkspaces/handoffParser';
import { buildSnapshot, parseSnapshotMetadata } from '../src/services/inboxSweep/noteSnapshot';
import { exclusionReason, guardSnapshot, policyRevisionOf, type SweepPolicy } from '../src/services/inboxSweep/sweepGuard';
import { sweepSkipReason } from '../src/services/inboxSweep/sweepScope';
import { usableText, userText, wordCount } from '../src/services/captureInbox/textFirst';
import { VALID_GTD_CONTEXTS } from '../src/services/validators/constants';

const SKILL_PATH = join(__dirname, '..', 'docs', 'skills', 'vault-handback', 'SKILL.md');
const skill = readFileSync(SKILL_PATH, 'utf8').replace(/\r\n/g, '\n');

/** The fenced block right after each `<!-- vault-handback:<kind> -->` marker, fences removed. */
function blocks(kind: string): string[] {
  const re = new RegExp(`<!-- vault-handback:${kind} -->\\n\`\`\`markdown\\n([\\s\\S]*?)\\n\`\`\`\\n`, 'g');
  return [...skill.matchAll(re)].map((m) => `${m[1]}\n`);
}

const contracts = blocks('contract');
const handbacks = blocks('example handback');
const captures = blocks('example capture');
const examples = [...handbacks, ...captures];
const CONTEXTS = [...VALID_GTD_CONTEXTS];
const DROP = '0 Inbox/From Claude/2026-11-07 Example.md';
const policy: SweepPolicy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20_000 };

/** The frontmatter lines of a note, without the `---` fences. */
function frontmatter(text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return m ? m[1].split('\n') : [];
}

describe('vault-handback skill: package', () => {
  const head = frontmatter(skill);
  const field = (k: string) => head.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? '';

  it('has a valid name and a description within the upload limits', () => {
    expect(field('name')).toBe('vault-handback');
    expect(field('name')).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(field('name')).not.toMatch(/claude|anthropic/i);
    const description = field('description');
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
  });

  it('finds every block it checks (the extraction itself works)', () => {
    expect(contracts).toHaveLength(1);
    expect(handbacks).toHaveLength(1);
    expect(captures.length).toBeGreaterThanOrEqual(2);
  });

  it('every fenced block in the skill carries a known marker, so no example escapes these checks', () => {
    // Opening fences only: a fence line with an info string (closing fences are a bare ```).
    const fences = skill.split('\n').filter((l) => /^```\S/.test(l)).length;
    const marked = [...skill.matchAll(/<!-- vault-handback:(contract|example handback|example capture) -->\n```markdown\n/g)].length;
    expect(fences).toBeGreaterThan(0);
    expect(marked).toBe(fences);
    expect(contracts.length + examples.length).toBe(fences);
  });

  it('the contexts the skill offers are the plugin\'s default contexts', () => {
    const line = skill.split('\n').find((l) => l.includes('Add one context from'));
    const offered = [...(line ?? '').matchAll(/@[a-z]+/g)].map((m) => m[0]);
    expect(offered).toEqual(CONTEXTS);
  });
});

describe('vault-handback skill: the hand-back grammar is the plugin\'s', () => {
  it('the grammar block is exactly renderHandoffContract', () => {
    expect(contracts[0].trimEnd()).toBe(renderHandoffContract('<project id, only if the user gave it>'));
  });

  it('the example uses the contract\'s sections, in the contract\'s order', () => {
    const sections = handbacks[0].split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4));
    expect(sections).toEqual([...HANDOFF_SECTIONS]);
    expect(handbacks[0]).toMatch(/^## Handoff$/m);
  });

  it('the example parses cleanly: every section, the chat project, contexts, waiting and due', () => {
    const p = parseHandoff(handbacks[0], CONTEXTS);
    expect(p.status).toBe('ok');
    expect(p.reasons).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.projectId).toBeUndefined();
    expect(p.chat).toEqual({ name: 'Website brain', app: 'claude' });
    expect(p.decisions.map((d) => [d.claim, d.text])).toEqual([['suggested', 'Build the new site as a static site'], ['decided', 'Launch in March']]);
    expect(p.actions).toHaveLength(2);
    expect(p.actions[0]).toMatchObject({ text: 'Email Dana the draft site map', contexts: ['@computer'], due: '2026-11-20' });
    expect(p.actions[1]).toMatchObject({ text: 'Ask the designer for the logo files', contexts: [], waiting: 'Sam' });
    expect(p.deliverables).toEqual([expect.objectContaining({ fileName: 'sitemap_v02.md', text: expect.stringContaining('page list with owners'), status: 'draft' })]);
    expect(p.questions.map((q) => q.text)).toEqual(['Who signs off the final copy?']);
    expect(p.more).toEqual({});
  });

  it('the plugin recognises the example as a hand-back (so the sweep and capture inbox leave it to its review)', () => {
    expect(looksLikeHandback(handbacks[0])).toBe(true);
  });

  it('a hand-back pasted with its fence is not seen: the skill\'s no-fence rule matters', () => {
    const fenced = `\`\`\`markdown\n${handbacks[0]}\`\`\`\n`;
    expect(parseHandoff(fenced, CONTEXTS).status).toBe('malformed');
  });
});

describe('vault-handback skill: captures', () => {
  it.each(captures.map((c, i) => [i, c] as const))('capture %i is usable text, not a hand-back, not reading', (_i, text) => {
    expect(looksLikeHandback(text)).toBe(false);
    // The capture inbox reads the note's whole body as the user's text: nothing of it is lost.
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    expect(userText(text, '2026-11-07 Example').trim()).toBe(body);
    expect(wordCount(usableText(text, '2026-11-07 Example'))).toBeGreaterThanOrEqual(10);
    expect(sweepSkipReason(DROP, text, { skipFolders: [], skipSourceLinked: true })).toBeNull();
    expect(text.length).toBeLessThan(12_000);
  });
});

describe('vault-handback skill: every example passes the sweep guard and never emits plugin-owned keys', () => {
  it.each(examples.map((e, i) => [i, e] as const))('example %i', async (_i, text) => {
    const meta = parseSnapshotMetadata(text);
    expect(meta.frontmatterOk).toBe(true);
    expect(meta.properties['created-by']).toEqual(['claude']);
    expect(exclusionReason(DROP, text, policy)).toBeNull();
    const revision = await policyRevisionOf(policy);
    expect(guardSnapshot(await buildSnapshot(DROP, text, revision), policy, revision).allowed).toBe(true);

    expect(text).not.toMatch(/\baio-(id|role)\b/);
    expect(text).not.toMatch(/\bcapture-(id|status)\b/);
    expect(text).not.toMatch(/<!--\s*aio:/);
    // Every text value is quoted; only the boolean flag is bare.
    for (const line of frontmatter(text)) expect(line).toMatch(/^[a-z-]+: ("[^"]*"|true)$/);
  });

  it('the guard really rejects what the skill forbids (the checks above can fail)', async () => {
    const unquoted = '---\ntitle: Pricing: annual\n---\nCall Priya about the venue deposit.\n';
    expect(exclusionReason(DROP, unquoted, policy)).toBe('unreadable');
  });

  it('the skill names each forbidden key, so the rule is stated where the model reads it', () => {
    for (const key of ['aio-id', 'aio-role', 'capture-id', 'capture-status', '`aio:`', '0 Inbox/From Claude/']) expect(skill).toContain(key);
  });
});
