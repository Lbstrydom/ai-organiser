/**
 * The capture inbox and the inbox sweep share one inbox and one privacy policy. Everything here holds with
 * the sweep SWITCHED OFF: the blocker, the rename tracking and the setup marker are the capture feature's own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { captureBlocker, captureOutputRoots, readCaptureConfig, remapSharedScope } from '../src/services/captureInbox/captureConfig';
import { CAPTURE_ERROR_CODES } from '../src/services/captureInbox/captureTypes';
import { GUIDANCE_CODES } from '../src/core/friendlyErrors';
import { evaluateSetup, toFolderSet } from '../src/core/setupState';
import { rekeyTree, upsertEntry, finish, addAlias } from '../src/services/captureInbox/captureJournal';
import { emptyJournal } from '../src/services/captureInbox/captureTypes';
import { en } from '../src/i18n/en';

const s = (over: Record<string, unknown> = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });
const ready = (over: Record<string, unknown> = {}) => s({ sweepInboxFolders: ['Inbox'], sweepExcludedTerms: ['acme'], ...over });

describe('captureBlocker (the shared fail-closed rule, with the sweep off)', () => {
  it('needs an inbox folder', () => {
    expect(captureBlocker(s() as never, true)).toBe('capture-no-folders');
  });

  it('needs a keep-out rule or the explicit "nothing to keep out"', () => {
    expect(captureBlocker(s({ sweepInboxFolders: ['Inbox'] }) as never, true)).toBe('capture-keepout-required');
    expect(captureBlocker(s({ sweepInboxFolders: ['Inbox'], sweepNothingToExclude: true }) as never, true)).toBeNull();
    expect(captureBlocker(ready() as never, true)).toBeNull();
  });

  it('a protected folder INSIDE the inbox does not stop the run (only that subfolder is skipped); a protected inbox still does', () => {
    expect(captureBlocker(ready({ protectedFolders: ['Inbox/Shielded'] }) as never, true)).toBeNull();
    expect(captureBlocker(ready({ protectedFolders: ['Inbox'] }) as never, true)).toBe('capture-inbox-invalid');
    expect(captureBlocker(ready({ sweepInboxFolders: ['Inbox/Sub'], protectedFolders: ['Inbox'] }) as never, true)).toBe('capture-inbox-invalid');
  });

  it('refuses a property rule that cannot be read, a protected or plugin-owned inbox, a bad destination, and a missing provider', () => {
    expect(captureBlocker(ready({ sweepExcludedProperties: ['nope'] }) as never, true)).toBe('sweep-property-invalid');
    expect(captureBlocker(ready({ sweepInboxFolders: ['Vault/Private'], protectedFolders: ['Vault'] }) as never, true)).toBe('capture-inbox-invalid');
    expect(captureBlocker(ready({ captureDestinationRoot: 'Inbox/Organised' }) as never, true)).toBe('capture-destination-refused');
    expect(captureBlocker(ready({ captureDestinationRoot: 'Archive', protectedFolders: ['Archive'] }) as never, true)).toBe('capture-destination-refused');
    expect(captureBlocker(ready() as never, false)).toBe('capture-no-provider');
  });

  it('treats the sweep report and the upkeep and agent-index folders as plugin output roots', () => {
    const roots = captureOutputRoots(ready({ sweepReportPath: 'Reports/sweep.md', upkeepReportFolder: 'Upkeep', agentIndexOutputPath: 'Idx/index.jsonl' }) as never);
    expect(roots).toEqual(expect.arrayContaining(['Reports/sweep.md', 'Upkeep', 'Idx']));
    expect(captureBlocker(ready({ sweepInboxFolders: ['Upkeep'], upkeepReportFolder: 'Upkeep' }) as never, true)).toBe('capture-inbox-invalid');
  });
});

describe('readCaptureConfig', () => {
  it('maps the settings to the plain config, converting units', () => {
    const cfg = readCaptureConfig(ready({ captureMaxAttachmentMB: 5, captureStabilitySeconds: 12, captureSince: 99, captureDestinationRoot: 'Areas' }) as never);
    expect(cfg).toMatchObject({ inboxFolders: ['Inbox'], maxAttachmentBytes: 5 * 1024 * 1024, stabilityMs: 12_000, since: 99, destinationRoot: 'Areas', onOpen: false });
  });
});

describe('rename tracking of the shared folders (works with the sweep off)', () => {
  it('remaps the inbox, the keep-out folders and the destination, and is idempotent', () => {
    const settings = ready({ sweepExcludedFolders: ['Private/Clients'], captureDestinationRoot: 'Areas' });
    const first = remapSharedScope(settings as never, 'Private', 'Locked');
    expect(first).toMatchObject({ sweepExcludedFolders: ['Locked/Clients'], changed: true });
    const renamedInbox = remapSharedScope(settings as never, 'Inbox', 'Capture');
    expect(renamedInbox.sweepInboxFolders).toEqual(['Capture']);
    const dest = remapSharedScope(settings as never, 'Areas', 'Projects');
    expect(dest.captureDestinationRoot).toBe('Projects');
    // applying the same rename to the already-renamed settings changes nothing
    const again = remapSharedScope({ ...settings, sweepExcludedFolders: first.sweepExcludedFolders } as never, 'Private', 'Locked');
    expect(again.changed).toBe(false);
    expect(remapSharedScope(settings as never, 'Elsewhere', 'Else').changed).toBe(false);
  });

  it('a renamed keep-out folder keeps keeping notes out (no leak after a rename)', () => {
    const settings = ready({ sweepExcludedFolders: ['Private'] });
    const next = remapSharedScope(settings as never, 'Private', 'Locked');
    expect(next.sweepExcludedFolders).toEqual(['Locked']);
  });

  it('re-keys the journal for a renamed file and a moved folder, including aliases and tombstones', () => {
    const base = { processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, fingerprint: 'f' } as const;
    let j = upsertEntry(emptyJournal(), { ...base, id: 'Inbox/a.md', state: 'awaiting_review' });
    j = upsertEntry(j, { ...base, id: 'Inbox/sub/b.md', state: 'awaiting_review' });
    j = upsertEntry(j, { ...base, id: 'Inbox/c.md', state: 'ready' });
    j = finish(j, 'Inbox/c.md', 'accepted', 1);
    j = addAlias(j, 'Inbox/m.m4a', 'Inbox/a.md');
    const moved = rekeyTree(j, 'Inbox', 'Capture');
    expect(Object.keys(moved.entries).sort()).toEqual(['Capture/a.md', 'Capture/sub/b.md']);
    expect(moved.tombstones['Capture/c.md']).toBeDefined();
    expect(moved.aliases['Capture/m.m4a']).toBe('Capture/a.md');
    const one = rekeyTree(j, 'Inbox/a.md', 'Inbox/z.md');
    expect(Object.keys(one.entries).sort()).toEqual(['Inbox/sub/b.md', 'Inbox/z.md']);
    expect(rekeyTree(j, 'Nowhere', 'Else')).toBe(j);
  });
});

describe('setup state (its own marker, independent of the sweep)', () => {
  it('is ready after the capture setup marker with an existing inbox folder, not after the sweep marker', () => {
    const withCapture = ready({ featureSetupCompletedAt: { 'capture-inbox': 'T' } }) as never;
    expect(evaluateSetup('capture-inbox', withCapture, { existingFolders: toFolderSet(['Inbox']) }).state).toBe('ready');
    const withSweepOnly = ready({ featureSetupCompletedAt: { 'inbox-sweep': 'T' } }) as never;
    expect(evaluateSetup('capture-inbox', withSweepOnly, { existingFolders: toFolderSet(['Inbox']) }).state).toBe('not-set-up');
    expect(evaluateSetup('capture-inbox', withCapture, { existingFolders: toFolderSet(['Other']) })).toEqual({ state: 'needs-attention', reason: 'missing-folder' });
  });
});

describe('guidance for every capture error code', () => {
  const guidance = en.guidance as unknown as Record<string, { message: string; nextStep: string }>;
  for (const code of [...CAPTURE_ERROR_CODES, 'sweep-capture-loading']) {
    it(`${code} is a guidance code with a message and a next step`, () => {
      expect(GUIDANCE_CODES).toContain(code);
      expect(guidance[code].message.length).toBeGreaterThan(10);
      expect(guidance[code].nextStep.length).toBeGreaterThan(10);
    });
  }
});

describe('naming guard', () => {
  const forbidden = new RegExp(['brain', 'toss'].join(''), 'i');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|md|css)$/.test(name) ? [p] : [];
    });
  const root = join(__dirname, '..');

  it('no phone-capture product is named in the source, the strings or the docs', () => {
    const files = [...walk(join(root, 'src'))];
    const doc = join(root, 'docs', 'features', 'capture-inbox.md');
    if (existsSync(doc)) files.push(doc);
    const offenders = files.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
