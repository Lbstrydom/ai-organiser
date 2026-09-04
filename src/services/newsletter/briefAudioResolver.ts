/**
 * Brief-audio resolver — pure matching for the host playback signal.
 *
 * Decides whether a rendered `<audio>` element is a newsletter daily-brief
 * recording, and if so which bucket it belongs to. Kept pure and separate from
 * the service because this matching is where false positives and false
 * negatives live, and because the plugin coordinator should not carry newsletter
 * storage semantics.
 *
 * It deliberately does NOT re-encode the digest naming rule. The caller supplies
 * `digestPathForDate`, a thin wrapper around the existing `getDigestPath`, so
 * that helper stays the single source of truth and any future change to folder
 * normalisation or the digest filename propagates here automatically.
 */

export interface BriefAudioResolution {
    bucketDate: string;
    audioBasename: string;
}

export interface ResolveBriefAudioInput {
    /** `ctx.sourcePath` from the markdown post-processor. */
    sourcePath: string;
    /** The audio element's `src`. */
    audioSrc: string;
    /** Wrapper around getDigestPath(newsletterRoot, dateStr). */
    digestPathForDate: (dateStr: string) => string;
}

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const BRIEF_AUDIO_RE = /^brief-.+\.(?:wav|mp3)$/i;

/**
 * Percent-decode without ever throwing.
 *
 * `decodeURIComponent` throws on a malformed sequence such as `%zz`, and this
 * runs on a host-supplied string inside a markdown post-processor — a throw
 * there is an invisible failure that breaks rendering for the whole note.
 */
function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** Normalise a vault-ish path for comparison. */
function canonicalise(path: string): string {
    // Strip the query and fragment BEFORE decoding. Decoding first would turn a
    // legitimately encoded `%3F` inside a folder name into a real `?`, and this
    // regex would then truncate the path at it.
    return safeDecode(path.replace(/[?#].*$/, ''))
        .replaceAll('\\', '/')
        .replaceAll(/\/{2,}/g, '/')
        .replace(/^\//, '')
        .trim();
}

/** True when yyyy-mm-dd names a real calendar date (rejects 2026-02-31). */
function isRealDate(y: number, m: number, d: number): boolean {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * Resolve a played audio element to its newsletter bucket, or null.
 *
 * Returns the basename rather than a revision: only the ledger knows which
 * revision a given recording was rendered from, and guessing the current one
 * would mark stories the reader never heard as consumed.
 */
export function resolveBriefAudioBucket(input: ResolveBriefAudioInput): BriefAudioResolution | null {
    const sourcePath = canonicalise(input.sourcePath ?? '');
    const audioPath = canonicalise(input.audioSrc ?? '');
    if (sourcePath.length === 0 || audioPath.length === 0) return null;

    const audioBasename = audioPath.split('/').pop() ?? '';
    if (!BRIEF_AUDIO_RE.test(audioBasename)) return null;

    const basename = sourcePath.split('/').pop() ?? '';
    const m = DATE_RE.exec(basename);
    if (!m) return null;

    const [, ys, ms, ds] = m;
    if (!isRealDate(Number(ys), Number(ms), Number(ds))) return null;
    const bucketDate = `${ys}-${ms}-${ds}`;

    // The authority check: is this path THE digest path for that date?
    let expected: string;
    try {
        expected = canonicalise(input.digestPathForDate(bucketDate));
    } catch {
        return null;
    }
    if (expected.length === 0 || expected !== sourcePath) return null;

    return { bucketDate, audioBasename };
}
