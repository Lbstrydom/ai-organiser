/**
 * Storyline-note detector (presentation-demo-fixes B3) — ONE canonical, pure
 * classifier shared by the `build-presentation-from-storyline` command preflight
 * AND the handler's `buildFromStorylineNote` revalidation, so the two can't drift
 * (R2-M3). No Obsidian imports — takes a plain string.
 *
 * Detection is CONTENT-based: a consultant storyline `.md` carries one hidden
 * `<!-- aio-slide:N base64 -->` anchor per slide, each under a `##` action-title
 * heading. The scan is FENCE-AWARE: anchors inside ``` / ~~~ fenced code blocks
 * are ignored, so a storyline pasted into an example/quote isn't a false positive.
 */

export type StorylineKind = 'ok' | 'not-storyline' | 'empty';

export interface StorylineClassification {
    kind: StorylineKind;
    reason?: string;
}

const ANCHOR_RE = /<!--\s*aio-slide:/;
const HEADING_RE = /^##\s+\S/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Classify a note as a buildable storyline. The `ok` predicate is precise (audit
 * M4/M21): at least one slide anchor must appear AT OR AFTER a `##` heading, in
 * document order, outside code fences — not merely "a heading and an anchor exist
 * somewhere". Returns:
 *  - `ok`            ≥1 slide anchor under a `##` heading,
 *  - `empty`         the body is blank (nothing to build),
 *  - `not-storyline` non-empty but no anchor sits under a heading.
 */
export function classifyStorylineNote(content: string): StorylineClassification {
    const text = content ?? '';
    if (text.trim().length === 0) {
        return { kind: 'empty', reason: 'note is blank' };
    }

    let inFence = false;
    let sawHeading = false;
    let anyAnchor = false;
    let anchorUnderHeading = false;
    for (const line of text.split(/\r?\n/)) {
        if (FENCE_RE.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (HEADING_RE.test(line)) sawHeading = true;
        if (ANCHOR_RE.test(line)) {
            anyAnchor = true;
            if (sawHeading) anchorUnderHeading = true;
        }
    }

    if (anchorUnderHeading) return { kind: 'ok' };
    return {
        kind: 'not-storyline',
        reason: anyAnchor
            ? 'slide anchors are not under a "##" heading'
            : 'no aio-slide anchors outside code fences',
    };
}

/** Trivial boolean wrapper used by the command preflight. */
export function isStorylineNote(content: string): boolean {
    return classifyStorylineNote(content).kind === 'ok';
}
