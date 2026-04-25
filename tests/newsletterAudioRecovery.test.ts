/**
 * Newsletter audio recovery sweep tests.
 *
 * Pins the contract for the "consistently generate audio for closed buckets"
 * fix (user report 2026-04-25 — April 24 digest had brief but no podcast
 * because the last newsletter landed at 07:53 AM, just before an 08:00
 * cutoff, so `isBucketClosed` returned false and audio was deferred; no
 * later fetch ever revisited that bucket).
 *
 * Tests target the three pure helpers the sweep relies on:
 *   - extractBriefFromDigest: parsing the managed brief block
 *   - hasAudioEmbed: idempotency guard
 *   - formatLocalYmd: deterministic local-time date keys
 *
 * The orchestration loop itself (recoverMissedAudioPodcasts) needs a real
 * vault + LLM + TTS to fully exercise; we test the slices that have
 * deterministic input/output.
 */

import { describe, it, expect } from 'vitest';
import {
    extractBriefFromDigest,
    hasAudioEmbed,
    formatLocalYmd,
} from '../src/services/newsletter/newsletterService';

const DIGEST_WITHOUT_AUDIO = `---
tags:
  - newsletter-digest
created: 2026-04-24
newsletter_count: 19
---

# Newsletter Digest — April 24, 2026

<!-- DAILY_BRIEF_START -->
## Daily Brief

### Geopolitics

- **AccelerateEU energy package**: relevant content here.
- **US-Iran nuclear diplomacy**: more content.

### Tech & AI

- **DeepSeek V4 launched**: details.

<!-- DAILY_BRIEF_END -->

## Sources

- [[2026-04-24/Source A|Source A]]
- [[2026-04-24/Source B|Source B]]
`;

const DIGEST_WITH_AUDIO = `---
tags:
  - newsletter-digest
---

# Newsletter Digest — April 23, 2026

🎧 **Listen:** ![[brief-2026-04-23-dba1f1e3.mp3]]

<!-- DAILY_BRIEF_START -->
## Daily Brief

- A bullet.
- Another bullet.

<!-- DAILY_BRIEF_END -->
`;

const DIGEST_WITH_EMBED_INSIDE_BRIEF = `---
tags: [newsletter-digest]
---

# Newsletter Digest — April 22, 2026

<!-- DAILY_BRIEF_START -->
## Daily Brief

🎧 **Listen:** ![[brief-2026-04-22-abc.wav]]

- Real brief content here.

<!-- DAILY_BRIEF_END -->
`;

const DIGEST_WITHOUT_BRIEF_BLOCK = `---
tags:
  - newsletter-digest
---

# Newsletter Digest — April 21, 2026

## Sources

- Just sources, no brief was synthesised.
`;

describe('hasAudioEmbed', () => {
    it('returns true when the audio embed line is present', () => {
        expect(hasAudioEmbed(DIGEST_WITH_AUDIO)).toBe(true);
    });

    it('returns false when no audio embed line is present', () => {
        expect(hasAudioEmbed(DIGEST_WITHOUT_AUDIO)).toBe(false);
    });

    it('matches both .mp3 and .wav embeds', () => {
        const mp3 = '🎧 **Listen:** ![[brief-2026-04-23-x.mp3]]';
        const wav = '🎧 **Listen:** ![[brief-2026-04-23-y.wav]]';
        expect(hasAudioEmbed(mp3)).toBe(true);
        expect(hasAudioEmbed(wav)).toBe(true);
    });

    it('rejects unrelated audio embeds (different filename pattern)', () => {
        const unrelated = '![[some-other-recording.mp3]]';
        expect(hasAudioEmbed(unrelated)).toBe(false);
    });

    it('detects audio embed regardless of position in the file (idempotency guard)', () => {
        // The recovery sweep must skip digests that already have audio,
        // whether the embed sits at the top (current convention) or got
        // wedged inside the brief block by an earlier render.
        expect(hasAudioEmbed(DIGEST_WITH_EMBED_INSIDE_BRIEF)).toBe(true);
    });
});

describe('extractBriefFromDigest', () => {
    it('returns the brief paragraphs when the managed block is present', () => {
        const brief = extractBriefFromDigest(DIGEST_WITHOUT_AUDIO);
        expect(brief).toContain('AccelerateEU energy package');
        expect(brief).toContain('DeepSeek V4 launched');
    });

    it('strips the section header but keeps body markdown', () => {
        const brief = extractBriefFromDigest(DIGEST_WITHOUT_AUDIO);
        expect(brief.startsWith('## Daily Brief')).toBe(false);
        expect(brief).toContain('### Geopolitics');
    });

    it('strips any prior audio embed line that sits inside the brief block', () => {
        // Belt-and-braces: a previous version of injectAudioEmbedIntoDigest
        // may have written the embed inside the managed block. The sweep
        // must extract the brief without that line so the LLM script
        // generator does not treat "Listen: ..." as content to narrate.
        const brief = extractBriefFromDigest(DIGEST_WITH_EMBED_INSIDE_BRIEF);
        expect(brief).not.toContain('🎧');
        expect(brief).not.toContain('Listen');
        expect(brief).toContain('Real brief content here.');
    });

    it('returns empty string when there is no managed brief block', () => {
        expect(extractBriefFromDigest(DIGEST_WITHOUT_BRIEF_BLOCK)).toBe('');
    });

    it('returns empty string when the brief block is empty', () => {
        const empty = `# Title
<!-- DAILY_BRIEF_START -->
## Daily Brief

<!-- DAILY_BRIEF_END -->`;
        expect(extractBriefFromDigest(empty)).toBe('');
    });

    it('trims surrounding whitespace from the extracted brief', () => {
        const padded = `<!-- DAILY_BRIEF_START -->
## Daily Brief

   - A bullet.

<!-- DAILY_BRIEF_END -->`;
        const brief = extractBriefFromDigest(padded);
        expect(brief.startsWith('-')).toBe(true);
        expect(brief.endsWith('.')).toBe(true);
    });
});

describe('formatLocalYmd', () => {
    it('formats a date as YYYY-MM-DD with zero-padding', () => {
        const d = new Date(2026, 0, 5);
        expect(formatLocalYmd(d)).toBe('2026-01-05');
    });

    it('uses LOCAL date parts (not UTC)', () => {
        // Construct via local-time components so the assertion is stable
        // regardless of the test runner's TZ.
        const d = new Date(2026, 3, 24, 23, 59, 0);
        expect(formatLocalYmd(d)).toBe('2026-04-24');
    });

    it('zero-pads single-digit months and days', () => {
        const d = new Date(2026, 1, 1);
        expect(formatLocalYmd(d)).toBe('2026-02-01');
    });
});

describe('recovery sweep — end-to-end semantics (pure-helper composition)', () => {
    // The recovery sweep's decision is essentially: for each closed bucket
    // in the lookback window, generate audio iff the digest has a brief
    // AND no audio embed. These tests pin that decision matrix.
    it('skips digests that already have audio (idempotent re-runs)', () => {
        // Caller would: read digest content, check hasAudioEmbed → true → skip.
        expect(hasAudioEmbed(DIGEST_WITH_AUDIO)).toBe(true);
    });

    it('targets digests with brief content but no audio embed', () => {
        expect(hasAudioEmbed(DIGEST_WITHOUT_AUDIO)).toBe(false);
        const brief = extractBriefFromDigest(DIGEST_WITHOUT_AUDIO);
        expect(brief.length).toBeGreaterThan(50); // generateAudioForBrief threshold
    });

    it('skips digests where the brief block is missing or empty', () => {
        // Digest exists but no brief was synthesised → sweep must not
        // attempt audio (would feed empty content to the LLM).
        expect(extractBriefFromDigest(DIGEST_WITHOUT_BRIEF_BLOCK)).toBe('');
    });
});
