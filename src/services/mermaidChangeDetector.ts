/**
 * MermaidChangeDetector
 * Tracks note content snapshots to detect whether a mermaid diagram
 * may be stale — i.e. the source note has changed meaningfully since
 * the diagram was last applied.
 *
 * Algorithm:
 *  - On applyToNote, capture a "snapshot": heading structure + word set + timestamp
 *  - On subsequent modal opens, compare new heading structure + word set against snapshot
 *  - If similarity drops below MIN_JACCARD_SIMILARITY → report stale
 *
 * Snapshots are keyed by a "block fingerprint" (first 80 chars of diagram code)
 * so each diagram in a vault is tracked independently.
 */

export interface NoteSnapshot {
    /** H1-H3 heading text joined into a single string, for structural comparison */
    headings: string;
    /** Unique words (lowercased, stop-words removed) for Jaccard similarity */
    wordSet: string[];
    /** Epoch ms when diagram was last applied */
    timestamp: number;
    /** If set, snooze staleness warnings until this epoch ms */
    snoozedUntil?: number;
}

export interface StalenessResult {
    isStale: boolean;
    similarity: number;
}

const MIN_JACCARD_SIMILARITY = 0.70;

/** Snooze duration: 30 minutes (§4.4 plan spec) */
const SNOOZE_DURATION_MS = 30 * 60 * 1000;

/**
 * Common English stop-words to exclude from Jaccard comparison so that
 * function-word churn does not trigger false positives.
 */
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'this', 'that', 'these', 'those',
    'it', 'its', 'as', 'if', 'not', 'no', 'so', 'up', 'into', 'than',
    'then', 'also', 'about',
]);

export class MermaidChangeDetector {
    /** fingerprint → snapshot */
    private readonly snapshots = new Map<string, NoteSnapshot>();

    // ── Capture ──────────────────────────────────────────────────────────────

    /**
     * Record a snapshot of the note content immediately after a diagram is applied.
     * @param fingerprint  Unique identifier for the diagram (e.g. first 80 chars of code)
     * @param content      Full text content of the note
     */
    captureSnapshot(fingerprint: string, content: string): void {
        const snapshot: NoteSnapshot = {
            headings: this.extractHeadings(content),
            wordSet: this.buildWordSet(content),
            timestamp: Date.now(),
        };
        this.snapshots.set(fingerprint, snapshot);
    }

    // ── Check ────────────────────────────────────────────────────────────────

    /**
     * Check whether the note has changed meaningfully since the last snapshot.
     * Returns `{ isStale: false }` if no snapshot exists yet.
     */
    checkStaleness(fingerprint: string, content: string): StalenessResult {
        const snapshot = this.snapshots.get(fingerprint);
        if (!snapshot) {
            return { isStale: false, similarity: 1 };
        }

        if (this.isSnoozed(fingerprint)) {
            return { isStale: false, similarity: 1 };
        }

        const currentWords = this.buildWordSet(content);
        const similarity = this.jaccardSimilarity(snapshot.wordSet, currentWords);

        // Also factor in heading changes as a quick structural signal
        const currentHeadings = this.extractHeadings(content);
        const headingsChanged = snapshot.headings !== currentHeadings;
        const wordsSimilar = similarity >= MIN_JACCARD_SIMILARITY;

        return {
            isStale: headingsChanged || !wordsSimilar,
            similarity,
        };
    }

    // ── Snooze ───────────────────────────────────────────────────────────────

    /**
     * Suppress future staleness warnings for this fingerprint for 30 minutes.
     */
    snooze(fingerprint: string): void {
        const existing = this.snapshots.get(fingerprint);
        if (existing) {
            existing.snoozedUntil = Date.now() + SNOOZE_DURATION_MS;
        } else {
            // Create a placeholder snapshot so we can store the snooze
            this.snapshots.set(fingerprint, {
                headings: '',
                wordSet: [],
                timestamp: Date.now(),
                snoozedUntil: Date.now() + SNOOZE_DURATION_MS,
            });
        }
    }

    isSnoozed(fingerprint: string): boolean {
        const snapshot = this.snapshots.get(fingerprint);
        if (!snapshot?.snoozedUntil) return false;
        return Date.now() < snapshot.snoozedUntil;
    }

    clearSnapshot(fingerprint: string): void {
        this.snapshots.delete(fingerprint);
    }

    hasSnapshot(fingerprint: string): boolean {
        return this.snapshots.has(fingerprint);
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private extractHeadings(content: string): string {
        const lines = content.split('\n');
        return lines
            .filter(l => /^#{1,3}\s/.test(l))
            .map(l => l.replace(/^#+\s+/, '').trim())
            .join('|');
    }

    private buildWordSet(content: string): string[] {
        // Remove code blocks and frontmatter before tokenising
        const cleaned = content
            .replace(/^---[\s\S]*?---/m, '')          // frontmatter
            .replace(/```[\s\S]*?```/g, '')            // fenced code
            .replace(/`[^`]+`/g, '')                   // inline code
            .replace(/\[\[.*?\]\]/g, (m) => m.replace(/[[\]|]/g, ' ')) // wikilinks
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .toLowerCase();

        const words = cleaned.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
        return [...new Set(words)];
    }

    private jaccardSimilarity(a: string[], b: string[]): number {
        if (a.length === 0 && b.length === 0) return 1;
        const setA = new Set(a);
        const setB = new Set(b);
        let intersection = 0;
        for (const word of setA) {
            if (setB.has(word)) intersection++;
        }
        const union = setA.size + setB.size - intersection;
        return union === 0 ? 1 : intersection / union;
    }
}
