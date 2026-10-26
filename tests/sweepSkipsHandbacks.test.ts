import { describe, it, expect } from 'vitest';
import { runSweep, type SweepDeps } from '../src/services/inboxSweep/sweepService';
import { looksLikeHandback } from '../src/services/aiWorkspaces/handoffParser';
import { ok } from '../src/core/result';

const policy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 100000 };
const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const HANDBACK = `# Session\n\nSome chat.\n\n## Handoff\nProject ID: ${ID}\n\n### Next actions\n- [ ] Email Dana\n\n### Questions\n- Who signs off?\n`;
const ORDINARY = '# Meeting\n\nCall Sam on Friday.\n';

describe('the sweep leaves AI hand-backs to their own review (persona F6)', () => {
  it('recognises a hand-back by its heading, a marker or the frontmatter flag, and not by prose or code', () => {
    expect(looksLikeHandback(HANDBACK)).toBe(true);
    expect(looksLikeHandback('# Notes\n- Decided x <!-- aio:handoff id=abc123 -->\n')).toBe(true);
    expect(looksLikeHandback('---\ntags: [a]\naio-handback: true\n---\nbody')).toBe(true);
    expect(looksLikeHandback('# Notes\n\n```\n## Handoff\n```\n')).toBe(false);
    expect(looksLikeHandback('We wrote a Handoff document last week.\n')).toBe(false);
    expect(looksLikeHandback(ORDINARY)).toBe(false);
    expect(looksLikeHandback('#### Handoff\n')).toBe(false);
  });

  it('a hand-back is never sent to the model, is counted, and an ordinary note beside it is still swept', async () => {
    const prompts: string[] = [];
    const texts: Record<string, string> = { 'Inbox/handback.md': HANDBACK, 'Inbox/meeting.md': ORDINARY };
    const deps: SweepDeps = {
      candidates: () => ['Inbox/handback.md', 'Inbox/meeting.md'],
      readText: async (p) => texts[p] ?? null,
      complete: async (prompt) => { prompts.push(prompt); return ok(JSON.stringify({ gtd_processing: { next_actions: [{ text: 'Call Sam', context: '', evidence: 'Call Sam on Friday' }], waiting_for: [], projects: [], someday_maybe: [] } })); },
      policy: () => policy,
      ledger: () => ({}),
      skipHandbacks: () => true,
    };
    const res = await runSweep(deps, { maxNotes: 5, maxChars: 12000 });
    if (!res.ok) throw new Error('run');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Email Dana');
    expect(res.value.notes.map((n) => n.path)).toEqual(['Inbox/meeting.md']);
    expect(res.value.skippedHandbacks).toBe(1);
  });

  it('with AI workspaces off the sweep reads a Handoff note like any other (byte-identical off path)', async () => {
    const prompts: string[] = [];
    const texts: Record<string, string> = { 'Inbox/handback.md': HANDBACK, 'Inbox/meeting.md': ORDINARY };
    const deps: SweepDeps = {
      candidates: () => ['Inbox/handback.md', 'Inbox/meeting.md'],
      readText: async (p) => texts[p] ?? null,
      complete: async (prompt) => { prompts.push(prompt); return ok(JSON.stringify({ gtd_processing: { next_actions: [], waiting_for: [], projects: [], someday_maybe: [] } })); },
      policy: () => policy,
      ledger: () => ({}),
    };
    const res = await runSweep(deps, { maxNotes: 5, maxChars: 12000 });
    if (!res.ok) throw new Error('run');
    expect(prompts).toHaveLength(2);
    expect(res.value.skippedHandbacks).toBeUndefined();
  });

  it('flag text quoted inside another frontmatter value is not a hand-back flag', () => {
    expect(looksLikeHandback('---\nsummary: "aio-handback: true"\n---\nbody')).toBe(false);
  });
});
