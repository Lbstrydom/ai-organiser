/**
 * Home-region alias parsing and matching.
 *
 * The user types a region as a separator-delimited alias list, e.g.
 * `Leidschendam; Voorburg; Den Haag; Zuid-Holland; Netherlands`. Sources whose
 * sender, subject or triage text mention one of those aliases are treated as
 * local news and protected from the brief's budget trimmer.
 *
 * Two design rules do most of the work here:
 *
 *  1. NO automatic whitespace sub-token splitting. An earlier design split
 *     multi-word aliases into words with a 3-character floor. That is not a
 *     small imprecision — `New York` yields `New`, `The Hague` yields `The`,
 *     `South Africa` yields `South`. Matched whole-word and case-insensitively,
 *     those appear in a large fraction of all newsletters, so nearly every
 *     source would be flagged local, every source would be drop-protected, and
 *     the protection would degenerate into no protection while over-trimming
 *     real content. A multi-word alias is matched AS A PHRASE, in full.
 *
 *  2. Every alias is regex-ESCAPED before use. This is user-authored text
 *     compiled into a matcher, so `C++`, `[`, or `St. Louis` must not crash or
 *     silently over-match.
 */

/** Max aliases honoured from one setting value. */
export const MAX_ALIASES = 12;
/** Max characters per alias. */
export const MAX_ALIAS_CHARS = 64;
/** Max characters read from the whole setting. */
export const MAX_REGION_CHARS = 400;

/**
 * Parse the setting into a de-duplicated alias list.
 *
 * Splits on `;` and `,` only. Every alias is kept AT ANY LENGTH, so short but
 * real region names (`UK`, `US`, `NY`, `SF`) work — there is no length floor,
 * because there is no automatic splitting for a floor to protect against.
 */
export function parseHomeRegionAliases(raw: string | undefined | null): string[] {
    if (!raw) return [];
    const out: string[] = [];
    const seen = new Set<string>();

    for (const part of raw.slice(0, MAX_REGION_CHARS).split(/[;,]/)) {
        const alias = part.trim().normalize('NFC').slice(0, MAX_ALIAS_CHARS);
        if (alias.length === 0) continue;
        const dedupKey = alias.toLowerCase();
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push(alias);
        if (out.length >= MAX_ALIASES) break;
    }
    return out;
}

function escapeRegex(literal: string): string {
    return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Whole-word, case-insensitive, phrase-complete match of any alias in `text`.
 *
 * Boundaries use explicit lookarounds against a Unicode letter/number class
 * rather than `\b`, because `\b` is ASCII-oriented and mishandles accented and
 * punctuated place names — `Zürich` and `Malmö` would match incorrectly at the
 * accented character.
 */
export function matchesAnyAlias(text: string, aliases: string[]): boolean {
    if (!text || aliases.length === 0) return false;
    const haystack = text.normalize('NFC');

    for (const alias of aliases) {
        // Internal whitespace in a phrase alias matches any run of whitespace,
        // so a line-wrapped "New\nYork" still matches.
        const body = escapeRegex(alias).replaceAll(/\\?\s+/g, String.raw`\s+`);
        const re = new RegExp(
            String.raw`(?<![\p{L}\p{N}])` + body + String.raw`(?![\p{L}\p{N}])`,
            'iu',
        );
        if (re.test(haystack)) return true;
    }
    return false;
}

/** The fields a source contributes to region matching. */
export interface RegionMatchBundle {
    senderName?: string;
    subject?: string;
    triageText?: string;
}

/**
 * Is this source about the reader's home region?
 *
 * Deliberately reads only sender, subject and the triage summary — NOT the full
 * note body. A global paper that mentions the region once in a long article
 * would otherwise be protected as "local", which would dilute the protection to
 * the point of uselessness.
 */
export function isRegionRelevant(bundle: RegionMatchBundle, region: string | undefined): boolean {
    const aliases = parseHomeRegionAliases(region);
    if (aliases.length === 0) return false;
    const haystack = [bundle.senderName, bundle.subject, bundle.triageText]
        .filter(Boolean)
        .join('\n');
    return matchesAnyAlias(haystack, aliases);
}
