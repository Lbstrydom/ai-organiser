/**
 * Sweep scope: notes the SWEEP leaves alone although they sit in an inbox folder. They are reading
 * (clipped articles, Web Reader output), not commitments. Capture inbox still sees them: this narrows
 * the sweep only and is never a privacy rule (the keep-out policy in `sweepGuard` stays the one
 * privacy list both features obey). Empty scope = the sweep reads every note, as it always did.
 */
import * as yaml from 'js-yaml';
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';

export interface SweepScope {
    /** Folders (and everything below them) the sweep skips */
    skipFolders: readonly string[];
    /** Skip notes whose properties carry a web link in `source` or `source_url` */
    skipSourceLinked: boolean;
}

export type SweepSkipReason = 'skip-folder' | 'source-link';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const WEB_LINK = /^https?:\/\/\S/i;

/** True when the note's frontmatter, parsed as YAML, has a top-level `source` / `source_url` string that is a web link. Unreadable YAML: false (the note is swept). */
export function hasSourceLink(text: string): boolean {
    const fm = FRONTMATTER.exec(text);
    if (!fm) return false;
    let data: unknown;
    try {
        data = yaml.load(fm[1], { schema: yaml.JSON_SCHEMA });
    } catch {
        return false;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    const props = data as Record<string, unknown>;
    return ['source', 'source_url'].some((k) => {
        const value = props[k];
        return typeof value === 'string' && WEB_LINK.test(value.trim());
    });
}

/** Why the sweep leaves this note alone, or null when it reads it. */
export function sweepSkipReason(path: string, text: string, scope: SweepScope | undefined): SweepSkipReason | null {
    if (!scope) return null;
    const norm = normalisePath(path);
    if (scope.skipFolders.some((f) => normalisePath(f) !== '' && isInsideOrEqual(norm, normalisePath(f)))) return 'skip-folder';
    if (scope.skipSourceLinked && hasSourceLink(text)) return 'source-link';
    return null;
}
