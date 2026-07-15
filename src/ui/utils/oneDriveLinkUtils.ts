import { getOs, getFs } from '../../utils/desktopRequire';
import { logger } from '../../utils/logger';

/**
 * Auto-detect local OneDrive-synced folders as a convenience `defaultPath`
 * for the native file dialog (docs/plans/onedrive-link-insert.md §6).
 *
 * A name-matched entry is included when it's a real directory, OR when it's
 * a symlink/junction that resolves to one (Gemini gate G1) — Windows OneDrive
 * relocation commonly leaves an NTFS junction at the original `OneDrive` path,
 * and newer macOS versions make `~/OneDrive` a symlink into
 * `~/Library/CloudStorage/OneDrive-<name>`. `dirent.isDirectory()` alone
 * returns `false` for both, which would silently defeat detection on exactly
 * the setups where a user relocated or upgraded.
 *
 * Each scan (home directory, then macOS CloudStorage) is independently
 * try/caught (round-3 M3) so a failure in one cannot discard results already
 * collected from the other. Results are sorted alphabetically (round-1 M2)
 * so `folders[0]` is deterministic, never dependent on filesystem
 * enumeration order.
 */
export function detectOneDriveFolders(): string[] {
    const os = getOs();
    const fs = getFs();
    if (!os || !fs) return [];

    const results: string[] = [];

    const scanDir = (dir: string): string[] => {
        const found: string[] = [];
        let entries: import('fs').Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            logger.warn('OneDriveLink', `Failed to scan ${dir} for OneDrive folders: ${String(error)}`);
            return found;
        }
        for (const entry of entries) {
            // audit round-1 L1: require a real delimiter (end-of-name, space, or
            // hyphen) immediately after "onedrive" — excludes an unrelated
            // "OneDriveBackup"-style name while still matching "OneDrive",
            // "OneDrive - Acme Corp" (Windows work-account form), and
            // "OneDrive-Acme" (macOS CloudStorage form, no spaces). A renamed
            // folder like "OneDrive-old" is structurally indistinguishable from
            // the legitimate hyphenated CloudStorage form and isn't solvable by
            // name pattern alone — not attempted here.
            if (!/^onedrive($|[\s-])/i.test(entry.name)) continue;
            const fullPath = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                found.push(fullPath);
                continue;
            }
            if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) found.push(fullPath);
                } catch (error) {
                    // round-4 L4: a broken symlink is expected and silently
                    // skipped, but access-denied/transient FS errors would
                    // otherwise vanish here too — log for diagnosability
                    // without changing the non-fatal detection behavior.
                    logger.warn('OneDriveLink', `Could not stat symlink ${fullPath}: ${String(error)}`);
                }
            }
        }
        return found;
    };

    results.push(...scanDir(os.homedir()));

    if (os.platform() === 'darwin') {
        results.push(...scanDir(`${os.homedir()}/Library/CloudStorage`));
    }

    return results.sort();
}

/**
 * Convert an OS absolute path to a `file://` URI. Returns `null` (never
 * throws) when the input doesn't match any recognized absolute-path shape
 * (round-1 M3). Exact per-segment encoding rules pinned down in round-3 M2:
 * only the Windows drive-letter / UNC host segment is left unencoded; every
 * other path segment is `encodeURIComponent`'d.
 */
export function buildFileUrl(absolutePath: string): string | null {
    const uncMatch = /^\\\\([^\\]+)\\(.*)$/.exec(absolutePath);
    if (uncMatch) {
        const [, host, rest] = uncMatch;
        const segments = rest.split('\\').filter((s) => s.length > 0).map(encodeURIComponent);
        return `file://${host}/${segments.join('/')}`;
    }

    const driveMatch = /^([A-Za-z]:)[\\/](.*)$/.exec(absolutePath);
    if (driveMatch) {
        const [, drive, rest] = driveMatch;
        const segments = rest.split(/[\\/]/).filter((s) => s.length > 0).map(encodeURIComponent);
        return `file:///${drive}/${segments.join('/')}`;
    }

    if (absolutePath.startsWith('/')) {
        const segments = absolutePath.split('/').filter((s) => s.length > 0).map(encodeURIComponent);
        return `file:///${segments.join('/')}`;
    }

    return null;
}

/** Characters that make a link destination unrepresentable as a CommonMark URI. */
// eslint-disable-next-line no-control-regex -- intentional: detects C0 controls + DEL that would corrupt a markdown link destination
const UNREPRESENTABLE_URL_CHARS = /[\x00-\x1f\x7f<>]/;

/**
 * Build a CommonMark-safe `[text](destination)` string. Scheme-agnostic —
 * shared by both the local `file://` path and the pasted-share-URL path
 * (round-3 M1's `https://` scheme allowlist lives at the caller, not here,
 * since this function must also accept `file://` output). Returns `null`
 * only when `url` contains a raw `<`, `>`, or control character/newline —
 * CommonMark's own angle-bracket destination form forbids those, so there
 * is no safe escaping for them (round-2 M1).
 *
 * `displayText` (audit round-3 M2): control characters/newlines are
 * stripped, not escaped — there's no meaningful visual representation of a
 * raw control byte in a link label, and a POSIX filename can legally
 * contain one. Silently dropping it is safer than either rejecting a
 * picked file outright or letting it corrupt the markdown link text.
 */
export function formatMarkdownLink(displayText: string, url: string): string | null {
    if (UNREPRESENTABLE_URL_CHARS.test(url)) return null;

    // eslint-disable-next-line no-control-regex -- intentional: strips C0 controls + DEL from the label, mirrors UNREPRESENTABLE_URL_CHARS
    const cleanedText = displayText.replace(/[\x00-\x1f\x7f]/g, '');
    const safeText = cleanedText.replace(/[[\]\\]/g, '\\$&');
    const needsWrap = /[\s()]/.test(url);
    const destination = needsWrap ? `<${url}>` : url;
    return `[${safeText}](${destination})`;
}

/**
 * How a picked local file should be represented in the note (onedrive-embed
 * extension, brainstormed 2026-07-15). `'embed'` = Obsidian natively renders
 * this type inline once vault-copied (PDF + common image formats — the same
 * set `![[...]]` already handles). `'vault-link'` = no native inline
 * renderer (Office formats), but a vault-copied `[[...]]` link still opens
 * in the user's system app on click (Obsidian's own default behaviour for
 * unrecognised attachment types) — no conversion pipeline, no internet
 * dependency. `'file-url'` = unrecognised extension, falls back to today's
 * shipped `file://` link (unchanged behaviour).
 */
export type OneDriveEmbedKind = 'embed' | 'vault-link' | 'file-url';

const EMBEDDABLE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);
const OFFICE_EXTENSIONS = new Set(['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls']);

export function classifyOneDriveEmbed(absolutePath: string): OneDriveEmbedKind {
    const dot = absolutePath.lastIndexOf('.');
    const ext = dot === -1 ? '' : absolutePath.slice(dot + 1).toLowerCase();
    if (EMBEDDABLE_EXTENSIONS.has(ext)) return 'embed';
    if (OFFICE_EXTENSIONS.has(ext)) return 'vault-link';
    return 'file-url';
}

/** A parsed `onedrive-embed` marker + the source line it was found on. */
export interface OneDriveEmbedMarker {
    source: string;
    vaultPath: string;
    mtimeMs: number;
    /** The exact marker comment text, for a precise string replace by the caller. */
    raw: string;
}

// eslint-disable-next-line no-control-regex -- intentional: rejects a source/vault path containing C0 controls, matching this module's existing URL-safety convention
const MARKER_UNSAFE_CHARS = /[\x00-\x1f\x7f"]|-->/;

/**
 * Build just the `<!-- onedrive-embed: ... -->` marker comment text (no
 * embed/link body line). Exported separately so the refresh command can
 * rebuild only the marker (with an updated `mtime`) via a plain string
 * replace, leaving the user's `![[...]]`/`[[...]]` line — and anything
 * they added around it — untouched. Returns `null` on marker-unsafe input,
 * same rule as `buildOneDriveEmbedBlock`.
 */
export function buildOneDriveEmbedMarkerText(sourcePath: string, vaultPath: string, mtimeMs: number): string | null {
    if (MARKER_UNSAFE_CHARS.test(sourcePath) || MARKER_UNSAFE_CHARS.test(vaultPath)) return null;
    // Live-testing finding (2026-07-15): `fs.Stats.mtimeMs` can carry a
    // fractional sub-millisecond component on some filesystems (observed:
    // `1784046442609.943`). Rounding here — the single choke point both the
    // insert and refresh paths go through — keeps the marker's stored value
    // a clean integer; `findStaleOneDriveEmbeds`'s own comparison already
    // rounds both sides, so this changes no comparison semantics.
    return `<!-- onedrive-embed: source="${sourcePath}" vault="${vaultPath}" mtime="${Math.round(mtimeMs)}" -->`;
}

/**
 * Build the `<!-- onedrive-embed: ... -->` marker + embed/link line pair
 * inserted after a vault-copied pick. Returns `null` (never throws) when
 * `sourcePath`/`vaultPath` contain a character that would break the HTML
 * comment or the attribute quoting (round-3 M2's same defensive posture as
 * `formatMarkdownLink` — a POSIX path can legally contain arbitrary bytes).
 */
export function buildOneDriveEmbedBlock(
    sourcePath: string,
    vaultPath: string,
    mtimeMs: number,
    kind: 'embed' | 'vault-link',
): string | null {
    const marker = buildOneDriveEmbedMarkerText(sourcePath, vaultPath, mtimeMs);
    if (marker === null) return null;
    const body = kind === 'embed' ? `![[${vaultPath}]]` : `[[${vaultPath}]]`;
    return `${marker}\n${body}`;
}

// mtime allows an optional fractional part defensively (belt-and-braces
// alongside the Math.round in buildOneDriveEmbedMarkerText) — a marker
// written before that rounding existed, or hand-edited, must still parse.
const MARKER_RE = /<!-- onedrive-embed: source="([^"]*)" vault="([^"]*)" mtime="(\d+(?:\.\d+)?)" -->/g;

/** Find every `onedrive-embed` marker in note content, in document order. */
export function parseOneDriveEmbedMarkers(content: string): OneDriveEmbedMarker[] {
    const markers: OneDriveEmbedMarker[] = [];
    for (const match of content.matchAll(MARKER_RE)) {
        const [raw, source, vaultPath, mtimeStr] = match;
        markers.push({ source, vaultPath, mtimeMs: Number(mtimeStr), raw });
    }
    return markers;
}
