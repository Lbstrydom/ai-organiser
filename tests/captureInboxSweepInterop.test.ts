/**
 * How the capture inbox and the inbox sweep share one inbox: the sweep must not read a capture that is
 * still held, must wait while the capture journal loads, and must see a capture again once it is accepted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { heldInboxCount, sweepPolicy, sweepRunPolicy } from '../src/services/inboxSweep/sweepCommit';
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

  it('counts the captures held for review inside the sweep inbox, so the sweep can say so instead of "kept out"', () => {
    const p = plugin(true);
    expect(heldInboxCount(p as never)).toBe(0);
    // held bare media (a voice memo with no note yet) is not a note the sweep left out
    setHeldMirror(['Inbox/a.md', 'Inbox/sub/b.md', 'Elsewhere/c.md', 'Inbox/memo.m4a']);
    expect(heldInboxCount(p as never)).toBe(2);
    // the preview judges the folders being drafted, not the saved ones
    expect(heldInboxCount(p as never, ['Elsewhere'])).toBe(1);
    expect(heldInboxCount(p as never, [])).toBe(0);
    expect(heldInboxCount(plugin(false) as never)).toBe(0);
    clearHeldMirror();
    expect(heldInboxCount(plugin(true) as never)).toBe(0);
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

  it('while a sweep runs a NEW hold applies at once and a RELEASE waits (the safe direction both ways)', () => {
    setHeldMirror(['Inbox/a.md']);
    freezeHeldMirror();
    setHeldMirror(['Inbox/a.md', 'Inbox/b.md']); // b becomes held mid-run
    expect(heldMirrorPaths().slice().sort()).toEqual(['Inbox/a.md', 'Inbox/b.md']);
    setHeldMirror(['Inbox/b.md']); // a is accepted mid-run: still held until the run ends
    expect(heldMirrorPaths().slice().sort()).toEqual(['Inbox/a.md', 'Inbox/b.md']);
    unfreezeHeldMirror();
    expect(heldMirrorPaths()).toEqual(['Inbox/b.md']);
  });

  it('a frozen mirror that was never loaded stays unloaded until the first update applies', () => {
    freezeHeldMirror();
    setHeldMirror([]);
    expect(isHeldMirrorLoaded()).toBe(false);
    unfreezeHeldMirror();
    expect(isHeldMirrorLoaded()).toBe(true);
  });
});
