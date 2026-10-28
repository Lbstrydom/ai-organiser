/**
 * Sweep scope: notes the SWEEP leaves alone although they sit in an inbox folder. They are reading
 * (clipped articles, Web Reader output), not commitments. Capture inbox still sees them: this narrows
 * the sweep only and is never a privacy rule (the keep-out policy in `sweepGuard` stays the one
 * privacy list both features obey). Empty scope = the sweep reads every note, as it always did.
 */
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';

export interface SweepScope {
    /** Folders (and everything below them) the sweep skips */
    skipFolders: readonly string[];
    /** Skip notes whose properties carry a web link in `source` or `source_url` */
    skipSourceLinked: boolean;
}

export type SweepSkipReason = 'skip-folder' | 'source-link';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// A top-level `source:` or `source_url:` whose value (optionally quoted) is an http(s) link.
const SOURCE_LINK = /^(?:source|source_url)\s*:\s*["']?https?:\/\/\S/im;

/** True when the note's frontmatter has a top-level `source` / `source_url` property holding a web link. */
export function hasSourceLink(text: string): boolean {
    const fm = FRONTMATTER.exec(text);
    return fm !== null && SOURCE_LINK.test(fm[1]);
}

/** Why the sweep leaves this note alone, or null when it reads it. */
export function sweepSkipReason(path: string, text: string, scope: SweepScope | undefined): SweepSkipReason | null {
    if (!scope) return null;
    const norm = normalisePath(path);
    if (scope.skipFolders.some((f) => normalisePath(f) !== '' && isInsideOrEqual(norm, normalisePath(f)))) return 'skip-folder';
    if (scope.skipSourceLinked && hasSourceLink(text)) return 'source-link';
    return null;
}
