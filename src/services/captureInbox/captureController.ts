/**
 * What the capture windows may ask of the feature. An interface only: the registrar implements it, the
 * modals and the settings section depend on this, not on each other.
 */
import type { CaptureJournalStore } from './captureJournalStore';
import type { AcceptEdits, OrganiseEdits } from './captureWriter';

export interface CaptureController {
    store: CaptureJournalStore;
    /** Estimate, confirm, then process. The only way a manual run starts. */
    processNow(): Promise<void>;
    openQueue(): void;
    openReview(id: string): void;
    /** Accept the text: the one write to the original. True when it was written. */
    accept(id: string, edits: AcceptEdits): Promise<boolean>;
    /** Create the organised note. Returns its path, or null when it was not created. */
    organise(id: string, edits: OrganiseEdits): Promise<string | null>;
    /** Preview, then mark the original processed (one property on the note; nothing moves). True when it was marked. */
    markProcessed(id: string): Promise<boolean>;
    /** Put the status back as Accept wrote it. True when it was restored. */
    unmarkProcessed(id: string): Promise<boolean>;
    skip(id: string): Promise<void>;
    /** Ask for a skipped capture to be looked at again (a limit was raised, a feature turned on, a file replaced). */
    retrySkipped(id: string): Promise<void>;
    /** How long a capture must stay unchanged before it counts as settled, in ms. */
    stabilityMs(): number;
    /** The inbox sweep feature is on (it may still need setup). */
    sweepFeatureOn(): boolean;
    /** Open the inbox sweep setup. */
    openSweepSetup(): void;
    retry(id: string): Promise<void>;
    /** Confirm processing an edited capture again. */
    processAgain(id: string): Promise<void>;
    /** Transcribe the audio even though the note already has text. */
    transcribeAnyway(id: string): Promise<void>;
    /** The folders an organised note may go in: the destination root and its allowed child folders. */
    folderOptions(): string[];
    /** The existing inbox sweep is on and ready to run. */
    sweepAvailable(): boolean;
    runSweep(): Promise<void>;
    openNote(path: string): void;
}
