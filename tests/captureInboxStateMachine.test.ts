import { describe, it, expect } from 'vitest';
import { canTransition, isHeld, isTerminal, transition } from '../src/services/captureInbox/captureStateMachine';
import type { CaptureEntry, CaptureState } from '../src/services/captureInbox/captureTypes';

const ALL: CaptureState[] = [
    'new', 'waiting_for_stable', 'ready', 'processing', 'awaiting_review', 'accept_pending_write',
    'accepted', 'organised', 'failed', 'skipped', 'skipped_by_user',
];

const entry = (state: CaptureState): CaptureEntry => ({
    id: 'Inbox/a.md', state, fingerprint: 'f', processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1,
});

describe('capture state machine', () => {
    it('allows the documented happy path', () => {
        const path: CaptureState[] = ['new', 'waiting_for_stable', 'ready', 'processing', 'awaiting_review', 'accept_pending_write', 'accepted', 'organised'];
        for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
    });

    it('allows processing to loop through stages and the failure and retry edges', () => {
        expect(canTransition('processing', 'processing')).toBe(true);
        expect(canTransition('processing', 'failed')).toBe(true);
        expect(canTransition('failed', 'ready')).toBe(true);
        expect(canTransition('failed', 'waiting_for_stable')).toBe(true);
        expect(canTransition('waiting_for_stable', 'waiting_for_stable')).toBe(true);
    });

    it('sends an edited-while-reviewing capture back to waiting, and a refused write back to review', () => {
        expect(canTransition('awaiting_review', 'waiting_for_stable')).toBe(true);
        expect(canTransition('accept_pending_write', 'awaiting_review')).toBe(true);
    });

    it('lets the user skip a held or failed capture but never an accepted one', () => {
        expect(canTransition('awaiting_review', 'skipped_by_user')).toBe(true);
        expect(canTransition('failed', 'skipped_by_user')).toBe(true);
        expect(canTransition('accepted', 'skipped_by_user')).toBe(false);
    });

    it('refuses every transition out of a finished state (except accepted -> organised)', () => {
        for (const from of ['organised', 'skipped', 'skipped_by_user'] as CaptureState[]) {
            for (const to of ALL) expect(canTransition(from, to)).toBe(false);
        }
        for (const to of ALL) expect(canTransition('accepted', to)).toBe(to === 'organised');
    });

    it('never writes before review: awaiting_review cannot reach accepted directly', () => {
        expect(canTransition('awaiting_review', 'accepted')).toBe(false);
        expect(canTransition('processing', 'accepted')).toBe(false);
    });

    it('holds everything before accepted (the sweep must wait), and nothing after', () => {
        for (const s of ['new', 'waiting_for_stable', 'ready', 'processing', 'awaiting_review', 'accept_pending_write', 'failed'] as CaptureState[]) {
            expect(isHeld(s)).toBe(true);
        }
        for (const s of ['accepted', 'organised', 'skipped', 'skipped_by_user'] as CaptureState[]) {
            expect(isHeld(s)).toBe(false);
            expect(isTerminal(s)).toBe(true);
        }
    });

    it('transition() returns the entry unchanged for a refused move and stamps updatedAt otherwise', () => {
        const refused = transition(entry('accepted'), 'ready', 9);
        expect(refused.ok).toBe(false);
        expect(refused.entry.state).toBe('accepted');
        const moved = transition(entry('ready'), 'processing', 9, { stage: 'read' });
        expect(moved.ok).toBe(true);
        expect(moved.entry).toMatchObject({ state: 'processing', stage: 'read', updatedAt: 9 });
    });

    it('fails closed on an unknown state', () => {
        expect(canTransition('bogus' as CaptureState, 'ready')).toBe(false);
    });
});
