/**
 * Which captures a manual run would really send, so the confirmation can state it truthfully. Pure.
 *
 * A run handles only captures that are settled (state `ready`), oldest first, at most `cap` of them. A capture
 * that has no journal entry yet is one the "Also process existing notes" box would add: it is old by definition
 * and needs no settling, so it counts as ready. Captures that are still settling are not sent by this run.
 */
import type { ScannedCapture } from './captureScanner';
import type { CaptureState } from './captureTypes';
import { planSources } from './textFirst';

export interface RunSelection {
    /** The captures this run sends, in the order it handles them */
    sent: ScannedCapture[];
    /** Ready captures that do not fit in this run and wait for the next one */
    later: number;
}

export function selectForRun(captures: readonly ScannedCapture[], stateOf: (id: string) => CaptureState | undefined, cap: number): RunSelection {
    const sendable = captures
        .filter((c) => {
            const state = stateOf(c.id);
            return state === undefined || state === 'ready';
        })
        .sort((a, b) => a.ctime - b.ctime);
    // A limit that is not a finite number sends nothing: fail closed rather than send everything.
    const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
    return { sent: sendable.slice(0, limit), later: Math.max(0, sendable.length - limit) };
}

export interface OutlayParams {
    minWords: number;
    digitiseImagesWithText: boolean;
    digitisationEnabled: boolean;
    maxImages: number;
}

export interface Outlay {
    /** Anything at all goes to the provider (text for tagging, audio, images) */
    sends: boolean;
    /** Audio bytes that will be transcribed (a note with enough text of its own is not) */
    audioBytes: number;
    /** Images that will be read (none while image reading is off) */
    images: number;
}

/**
 * What one capture will really send, by the same rules the run uses (text first, image reading on or off): an image that
 * will be skipped, or audio that a note's own text makes unnecessary, is not counted as sent. Pure.
 */
export function outlayOf(capture: ScannedCapture, params: OutlayParams, forceTranscribe?: boolean): Outlay {
    const name = capture.id.slice(capture.id.lastIndexOf('/') + 1);
    const audio = capture.attachments.filter((a) => a.kind === 'audio');
    const images = capture.attachments.filter((a) => a.kind === 'image');
    const plan = planSources({
        body: capture.text,
        fileName: name,
        audioCount: audio.length,
        imageCount: images.length,
        unsupportedCount: capture.attachments.filter((a) => a.kind === null).length,
        minWords: params.minWords,
        digitiseImagesWithText: params.digitiseImagesWithText,
        digitisationEnabled: params.digitisationEnabled,
        maxImages: params.maxImages,
        forceTranscribe,
    });
    if (plan.skip || !plan.source) return { sends: false, audioBytes: 0, images: 0 };
    return {
        sends: true,
        audioBytes: plan.transcribeAudio ? audio.reduce((n, a) => n + a.size, 0) : 0,
        images: plan.digitiseImages,
    };
}
