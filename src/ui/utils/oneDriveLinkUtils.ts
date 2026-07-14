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
