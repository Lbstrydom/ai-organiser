/**
 * Unit tests for `canGenerateMinutes` — the pure CTA-gating derivation
 * in src/ui/components/speakerReviewState.ts.
 *
 * Covers the post-multi-segment behaviour: transcript content can arrive
 * via the pasted textarea (`transcript`) OR via the multi-picker into
 * `transcriptItems[]` (`loadedTranscriptCount`). Either alone is
 * sufficient; review state still gates as before.
 */

import { describe, it, expect } from 'vitest';
import { canGenerateMinutes } from '../src/ui/components/speakerReviewState';
import type { SpeakerReviewState } from '../src/ui/components/speakerReviewState';

const NOT_REQUIRED: SpeakerReviewState = { kind: 'not-required' };
const PENDING: SpeakerReviewState = { kind: 'pending', detected: [] };
const CONFIRMED: SpeakerReviewState = {
    kind: 'confirmed',
    detected: [],
    mapping: {},
};
const SKIPPED_USER: SpeakerReviewState = { kind: 'skipped', detected: [], reason: 'user-skip' };
const SKIPPED_DETECTION_FAILED: SpeakerReviewState = { kind: 'skipped', detected: [], reason: 'detection-failed' };
const FAILED: SpeakerReviewState = { kind: 'failed', detected: [], error: 'boom' };

describe('canGenerateMinutes — content gate', () => {
    it('returns false when both transcript and loadedTranscriptCount are empty', () => {
        expect(canGenerateMinutes({ transcript: '', speakerReview: NOT_REQUIRED })).toBe(false);
    });

    it('returns false when transcript is whitespace-only and no loaded transcripts', () => {
        expect(canGenerateMinutes({ transcript: '   \n  \t', speakerReview: NOT_REQUIRED })).toBe(false);
    });

    it('returns false when loadedTranscriptCount is 0 even with whitespace transcript', () => {
        expect(canGenerateMinutes({
            transcript: '',
            loadedTranscriptCount: 0,
            speakerReview: NOT_REQUIRED,
        })).toBe(false);
    });

    it('passes content gate when ONLY pasted transcript is present', () => {
        expect(canGenerateMinutes({ transcript: 'Some text', speakerReview: NOT_REQUIRED })).toBe(true);
    });

    it('passes content gate when ONLY loadedTranscriptCount > 0 (new multi-picker path)', () => {
        expect(canGenerateMinutes({
            transcript: '',
            loadedTranscriptCount: 1,
            speakerReview: NOT_REQUIRED,
        })).toBe(true);
    });

    it('passes content gate when BOTH paste and loaded are present', () => {
        expect(canGenerateMinutes({
            transcript: 'pasted text',
            loadedTranscriptCount: 2,
            speakerReview: NOT_REQUIRED,
        })).toBe(true);
    });
});

describe('canGenerateMinutes — speaker-review gate', () => {
    const args = (review: SpeakerReviewState, opts: { loaded?: number; paste?: string } = {}) => ({
        transcript: opts.paste ?? 'paste',
        loadedTranscriptCount: opts.loaded,
        speakerReview: review,
    });

    it('blocks while review is pending', () => {
        expect(canGenerateMinutes(args(PENDING))).toBe(false);
        expect(canGenerateMinutes(args(PENDING, { loaded: 1, paste: '' }))).toBe(false);
    });

    it('blocks when review has failed', () => {
        expect(canGenerateMinutes(args(FAILED))).toBe(false);
    });

    it('allows when review is confirmed', () => {
        expect(canGenerateMinutes(args(CONFIRMED))).toBe(true);
    });

    it('allows when review was skipped by the user', () => {
        expect(canGenerateMinutes(args(SKIPPED_USER))).toBe(true);
    });

    it('allows when review was skipped due to detection failure (degraded UX still ships)', () => {
        expect(canGenerateMinutes(args(SKIPPED_DETECTION_FAILED))).toBe(true);
    });

    it('allows when review is not-required (no audio, no speakers to label)', () => {
        expect(canGenerateMinutes(args(NOT_REQUIRED))).toBe(true);
    });
});

describe('canGenerateMinutes — combined gates (loaded-only paths)', () => {
    it('multi-picker loaded transcript + pending review → still blocked (review takes precedence)', () => {
        expect(canGenerateMinutes({
            transcript: '',
            loadedTranscriptCount: 3,
            speakerReview: PENDING,
        })).toBe(false);
    });

    it('multi-picker loaded transcript + confirmed review → allowed', () => {
        expect(canGenerateMinutes({
            transcript: '',
            loadedTranscriptCount: 3,
            speakerReview: CONFIRMED,
        })).toBe(true);
    });

    it('multi-picker loaded transcript + skipped review → allowed', () => {
        expect(canGenerateMinutes({
            transcript: '',
            loadedTranscriptCount: 3,
            speakerReview: SKIPPED_USER,
        })).toBe(true);
    });
});
