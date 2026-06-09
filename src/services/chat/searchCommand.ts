/**
 * Mid-conversation web-search command parser (presentation slides / storyline).
 *
 * Sources normally resolve ONCE at deck creation. This lets the user pull in fresh
 * web research while iterating — `/search <query>` (aliases `/research`, `/web`) —
 * so a realisation mid-storyline or mid-slide-design can be grounded immediately.
 * Pure + side-effect-free so it's unit-testable; the handler owns the dispatch.
 */

/**
 * Parse a mid-conversation web-search command. Matches `/search <query>` (and the
 * `/research` / `/web` aliases), case-insensitive, requiring a non-trivial query.
 * Returns the trimmed query, or null when the message is a normal chat turn.
 */
export function parseSearchCommand(message: string): string | null {
    if (!message) return null;
    const m = message.trim().match(/^\/(?:search|research|web)\b[\s:]+([\s\S]+)$/i);
    if (!m) return null;
    const query = m[1].trim();
    return query.length >= 2 ? query : null;
}
