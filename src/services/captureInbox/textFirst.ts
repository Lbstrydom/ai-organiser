/**
 * Text-first source selection. A capture that already carries usable text is never uploaded as
 * audio: dictation and typed notes are the common case, and a transcript would cost money and add
 * errors to words the user already has. Pure.
 */
import { CAPTURE_BLOCK_END, CAPTURE_BLOCK_START } from './captureTypes';
import type { CaptureSource, SkipReason } from './captureTypes';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** A run of letters or digits is a word; each Han, Hiragana or Katakana character counts as one (no spaces in those scripts). */
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu;
/** Notes longer than this are not read for words: bounded work on a hostile or pasted note. */
const MAX_SCAN_CHARS = 120_000;

/** Removes the parts of a line that are not words the user wrote. */
function stripNoise(text: string): string {
    return text
        .replace(/!\[\[[^\]\n]{0,300}\]\]/g, ' ')
        .replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,500}\)/g, ' ')
        .replace(/\[\[[^\]\n]{0,300}\]\]/g, ' ')
        .replace(/\[[^\]\n]{0,300}\]\([^)\n]{0,500}\)/g, ' ')
        .replace(/<[^>\n]{0,300}>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The words the user actually wrote: frontmatter, the plugin block, embeds, links, bare URLs,
 * dates and clock times, and a heading that merely repeats the file name are not text.
 */
export function usableText(body: string, fileName: string): string {
    let text = body.slice(0, MAX_SCAN_CHARS).replace(FRONTMATTER, '');
    const start = text.indexOf(CAPTURE_BLOCK_START);
    const end = text.indexOf(CAPTURE_BLOCK_END);
    if (start !== -1 && end > start) text = text.slice(0, start) + text.slice(end + CAPTURE_BLOCK_END.length);
    const nameKey = squash(stripNoise(fileName.replace(/\.[^.]+$/, '')));
    return text
        .split(/\r?\n/)
        .filter((line) => !(nameKey && squash(stripNoise(line.replace(/^#+\s*/, ''))) === nameKey))
        .map(stripNoise)
        .join('\n')
        .trim();
}

export function wordCount(text: string): number {
    return (text.match(WORD) ?? []).length;
}

export interface TextFirstInput {
    /** The capture note body ('' for a bare media capture) */
    body: string;
    fileName: string;
    audioCount: number;
    imageCount: number;
    /** Attachments whose format is unsupported (named in the review) */
    unsupportedCount: number;
    minWords: number;
    /** `captureDigitiseImages`: digitise images even when the note has usable text */
    digitiseImagesWithText: boolean;
    /** The existing `digitisation` feature flag */
    digitisationEnabled: boolean;
    maxImages: number;
    /** The user's explicit "Transcribe the audio anyway" */
    forceTranscribe?: boolean;
}

export interface TextFirstPlan {
    source: CaptureSource | null;
    useNoteText: boolean;
    transcribeAudio: boolean;
    /** How many images to digitise (already capped) */
    digitiseImages: number;
    /** Audio is attached but not transcribed because the note already has text */
    audioSkippedBecauseText: boolean;
    skip?: SkipReason;
}

export function planSources(input: TextFirstInput): TextFirstPlan {
    const hasUsable = wordCount(usableText(input.body, input.fileName)) >= Math.max(1, input.minWords);
    const imagesAllowed = input.digitisationEnabled ? Math.min(input.imageCount, Math.max(0, input.maxImages)) : 0;

    let transcribeAudio = false;
    let digitise = 0;
    let audioSkippedBecauseText = false;

    if (hasUsable) {
        transcribeAudio = !!input.forceTranscribe && input.audioCount > 0;
        audioSkippedBecauseText = input.audioCount > 0 && !transcribeAudio;
        digitise = input.digitiseImagesWithText ? imagesAllowed : 0;
    } else {
        transcribeAudio = input.audioCount > 0;
        digitise = imagesAllowed;
    }

    const pieces = [hasUsable, transcribeAudio, digitise > 0].filter(Boolean).length;
    if (pieces === 0) {
        let skip: SkipReason = 'nothing-to-process';
        if (input.imageCount > 0 && !input.digitisationEnabled && input.audioCount === 0) skip = 'digitisation-off';
        else if (input.unsupportedCount > 0 && input.audioCount === 0 && input.imageCount === 0) skip = 'unsupported';
        return { source: null, useNoteText: false, transcribeAudio: false, digitiseImages: 0, audioSkippedBecauseText, skip };
    }

    let source: CaptureSource;
    if (pieces > 1) source = 'mixed';
    else if (hasUsable) source = 'note-text';
    else if (transcribeAudio) source = 'transcript';
    else source = 'digitised';

    return { source, useNoteText: hasUsable, transcribeAudio, digitiseImages: digitise, audioSkippedBecauseText };
}
