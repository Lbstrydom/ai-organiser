import { describe, it, expect } from 'vitest';
import { checkDestination, machineTextExclusion, pathExclusion, validateCaptureSetup, withHeldPaths, MACHINE_TEXT_MIN_CAP } from '../src/services/captureInbox/capturePolicy';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';

const policy = (over: Partial<SweepPolicy> = {}): SweepPolicy => ({
  excludedFolders: ['Private'], excludedTags: ['secret'], excludedProperties: [], excludedTerms: ['acme'],
  protectedFolders: ['Protected'], maxNoteChars: 20000, ...over,
});

describe('setup validation', () => {
  const codes = (inbox: string[], dest: string, prot: string[] = ['Protected'], roots: string[] = ['AI Organiser/Reports', 'Sweep']) =>
    validateCaptureSetup(inbox, dest, prot, roots).map((p) => p.code);

  it('accepts a clean setup', () => {
    expect(codes(['Inbox'], 'Areas')).toEqual([]);
  });

  it('requires an inbox: an empty, blank or root-only list is not one', () => {
    expect(codes([], 'Areas')).toContain('no-inbox');
    expect(codes([''], 'Areas')).toContain('no-inbox');
    expect(codes(['/'], 'Areas')).toContain('no-inbox');
  });

  it('flags an inbox that is, sits inside or contains a protected folder or output root', () => {
    expect(codes(['Protected'], '')).toContain('inbox-protected');
    expect(codes(['Protected/Sub'], '')).toContain('inbox-protected');
    expect(codes(['AI Organiser'], '')).toContain('inbox-output-root');
    expect(codes(['Sweep/x'], '')).toContain('inbox-output-root');
  });

  it('flags a destination root that is protected, an output root, or inside an inbox folder', () => {
    expect(codes(['Inbox'], 'Protected/Out')).toContain('destination-protected');
    expect(codes(['Inbox'], 'AI Organiser/Reports/x')).toContain('destination-output-root');
    expect(codes(['Inbox'], 'Inbox/Organised')).toContain('destination-in-inbox');
  });

  it('is case-insensitive and prefix-safe', () => {
    expect(codes(['protected'], '')).toContain('inbox-protected');
    expect(codes(['ProtectedLike'], '')).not.toContain('inbox-protected');
  });
});

describe('destination check', () => {
  const ctx = (exists = true) => ({ protectedFolders: ['Protected'], outputRoots: ['Sweep'], inboxFolders: ['Inbox'], exists: () => exists });

  it('allows an existing folder inside the destination root', () => {
    expect(checkDestination('Areas/Home', 'Areas', ctx())).toEqual({ ok: true, folder: 'Areas/Home' });
  });

  it('names the first failing rule', () => {
    expect(checkDestination('Areas/Home', '', ctx())).toEqual({ ok: false, reason: 'no-root' });
    expect(checkDestination('Other', 'Areas', ctx())).toEqual({ ok: false, reason: 'outside-root' });
    expect(checkDestination('Areas/../Other', 'Areas', ctx())).toEqual({ ok: false, reason: 'outside-root' });
    expect(checkDestination('Areas/Home', 'Areas', { ...ctx(), protectedFolders: ['Areas/Home'] })).toEqual({ ok: false, reason: 'protected' });
    expect(checkDestination('Areas/Sweep/x', 'Areas', { ...ctx(), outputRoots: ['Areas/Sweep'] })).toEqual({ ok: false, reason: 'output-root' });
    expect(checkDestination('Areas/Home', 'Areas', { ...ctx(), inboxFolders: ['Areas'] })).toEqual({ ok: false, reason: 'in-inbox' });
    expect(checkDestination('Areas/Home', 'Areas', ctx(false))).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('exclusion reuse', () => {
  it('also matches keep-out words against the attachment name', () => {
    expect(pathExclusion('Inbox/acme call.m4a', policy())).toBe('term');
  });

  it('judges an attachment by path alone (protected folder, kept-out folder)', () => {
    expect(pathExclusion('Protected/a.m4a', policy())).toBe('protected');
    expect(pathExclusion('Private/a.m4a', policy())).toBe('folder');
    expect(pathExclusion('Inbox/a.m4a', policy())).toBeNull();
  });

  it('excludes machine text containing a kept-out term or tag, before it is persisted', () => {
    expect(machineTextExclusion('Inbox/a.md', 'call ACME about the invoice', policy())).toBe('term');
    expect(machineTextExclusion('Inbox/a.md', 'fine text #secret', policy())).toBe('tag');
    expect(machineTextExclusion('Inbox/a.md', 'fine text', policy())).toBeNull();
  });

  it('lets a long transcript through the guard (machine-text cap), but not past it', () => {
    const long = 'word '.repeat(8000);
    expect(long.length).toBeGreaterThan(20000);
    expect(machineTextExclusion('Inbox/a.md', long, policy())).toBeNull();
    expect(machineTextExclusion('Inbox/a.md', 'x'.repeat(MACHINE_TEXT_MIN_CAP + 1), policy())).toBe('too-large');
  });
});

describe('withHeldPaths (the sweep hook)', () => {
  it('returns the SAME policy object when nothing is held (byte-identical when the feature is off)', () => {
    const p = policy();
    expect(withHeldPaths(p, [])).toBe(p);
  });

  it('adds held note paths as exact exclusions, so the sweep guard excludes them and nothing else', () => {
    const p = withHeldPaths(policy(), ['Inbox/held.md']);
    expect(pathExclusion('Inbox/held.md', p)).toBe('folder');
    expect(pathExclusion('Inbox/held.md.bak', p)).toBeNull();
    expect(pathExclusion('Inbox/other.md', p)).toBeNull();
    expect(p.excludedFolders).toContain('Private');
  });
});
