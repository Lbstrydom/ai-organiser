/**
 * How the capture inbox and the inbox sweep share one inbox: the sweep must not read a capture that is
 * still held, must wait while the capture journal loads, and must see a capture again once it is accepted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { sweepPolicy, sweepRunPolicy } from '../src/services/inboxSweep/sweepCommit';
import { sweepBlocker } from '../src/commands/inboxSweepCommands';
import { exclusionReason } from '../src/services/inboxSweep/sweepGuard';
import { clearHeldMirror, freezeHeldMirror, heldMirrorPaths, isHeldMirrorLoaded, setCaptureActive, setCaptureCorrupt, setHeldMirror, unfreezeHeldMirror } from '../src/services/captureInbox/heldMirror';

const plugin = (captureOn: boolean) => (setCaptureActive(captureOn), {
  settings: {
    ...structuredClone(DEFAULT_SETTINGS),
    sweepInboxFolders: ['Inbox'], sweepExcludedTerms: ['acme'],
    featureFlags: { 'capture-inbox': captureOn, 'inbox-sweep': true },
  },
  llmService: {},
});

beforeEach(() => { unfreezeHeldMirror(); clearHeldMirror(); setCaptureActive(false); setCaptureCorrupt(false); });

describe('sweep and capture inbox interplay', () => {
  it('the sweep does not read a held capture, but reads its neighbours', () => {
    const p = plugin(true);
    setHeldMirror(['Inbox/held.md']);
    const policy = sweepRunPolicy(p as never);
    expect(exclusionReason('Inbox/held.md', 'some text', policy)).toBe('folder');
    expect(exclusionReason('Inbox/other.md', 'some text', policy)).toBeNull();
    expect(exclusionReason('Inbox/held.md.bak', 'some text', policy)).toBeNull();
  });

  it('the capture feature judges its own captures with the base policy, so it still sees them', () => {
    const p = plugin(true);
    setHeldMirror(['Inbox/held.md']);
    expect(exclusionReason('Inbox/held.md', 'some text', sweepPolicy(p as never))).toBeNull();
  });

  it('a capture is read by the sweep again once it is no longer held (accepted)', () => {
    const p = plugin(true);
    setHeldMirror(['Inbox/held.md']);
    expect(exclusionReason('Inbox/held.md', 'text', sweepRunPolicy(p as never))).toBe('folder');
    setHeldMirror([]);
    expect(exclusionReason('Inbox/held.md', 'text', sweepRunPolicy(p as never))).toBeNull();
  });

  it('fails closed until the capture journal has loaded: the sweep refuses, and if asked anyway holds out the whole inbox', () => {
    const p = plugin(true);
    expect(isHeldMirrorLoaded()).toBe(false);
    expect(sweepBlocker(p as never)).toBe('sweep-capture-loading');
    const policy = sweepRunPolicy(p as never);
    expect(exclusionReason('Inbox/anything.md', 'text', policy)).toBe('folder');
    setHeldMirror([]);
    expect(sweepBlocker(p as never)).not.toBe('sweep-capture-loading');
  });

  it('a corrupt capture journal stops the sweep with its own guidance, until the user resets it', () => {
    const p = plugin(true);
    setCaptureCorrupt(true);
    expect(sweepBlocker(p as never)).toBe('capture-journal-corrupt');
    setCaptureCorrupt(false);
    expect(sweepBlocker(p as never)).toBe('sweep-capture-loading');
    setHeldMirror([]);
    expect(sweepBlocker(p as never)).not.toBe('capture-journal-corrupt');
  });

  it('a feature flag switched on after load (no registrar, no journal) does not make the sweep wait', () => {
    const p = plugin(false);
    p.settings.featureFlags['capture-inbox'] = true;
    expect(sweepBlocker(p as never)).not.toBe('sweep-capture-loading');
    expect(sweepRunPolicy(p as never)).toEqual(sweepPolicy(p as never));
  });

  it('with the capture feature off, the sweep neither waits nor holds anything out', () => {
    const p = plugin(false);
    expect(sweepBlocker(p as never)).not.toBe('sweep-capture-loading');
    expect(sweepRunPolicy(p as never)).toEqual(sweepPolicy(p as never));
  });

  it('the held set is frozen while a sweep runs, so its policy cannot change under it', () => {
    setHeldMirror(['Inbox/a.md']);
    freezeHeldMirror();
    setHeldMirror(['Inbox/a.md', 'Inbox/b.md']);
    expect(heldMirrorPaths()).toEqual(['Inbox/a.md']);
    unfreezeHeldMirror();
    expect(heldMirrorPaths()).toEqual(['Inbox/a.md', 'Inbox/b.md']);
  });

  it('a frozen mirror that was never loaded stays unloaded until the first update applies', () => {
    freezeHeldMirror();
    setHeldMirror([]);
    expect(isHeldMirrorLoaded()).toBe(false);
    unfreezeHeldMirror();
    expect(isHeldMirrorLoaded()).toBe(true);
  });
});
