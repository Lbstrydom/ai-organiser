/**
 * Neutral prompt-safety util (debt plan D5). `escapeForPrompt` defangs ANY
 * XML/HTML-style tag in untrusted TEXT that is about to be embedded inside an
 * `<xml_section>` of a prompt — so embedded content cannot forge a section
 * boundary and escape the data envelope.
 *
 * TAG-AGNOSTIC by design (Gemini debt-gate): the older
 * `presentationChatPrompts` escaper only defanged a fixed list of chat tags and
 * would NOT have protected the IR prompt's own tags (`</current_deck>`,
 * `</edit_request>`, `</icons>`, …). This defangs every tag, so it is correct for
 * both vocabularies and any tag added later.
 *
 * Use ONLY for plain-text / JSON content. Do NOT use it on content that is
 * meant to contain real HTML the model must read (that needs a fixed-delimiter
 * escaper that preserves HTML tags — see `sanitizeHtmlForPrompt`).
 *
 * Pure — no Obsidian.
 */

// `<tag>`, `</tag>`, `<tag attr="x">`, `<tag/>` — any tag name.
const ANY_TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s[^>]*)?)(\/?)>/g;

/**
 * Defang every tag in `text` by inserting a space after `<` (`</icons>` →
 * `< /icons>`), preserving the slash, tag name, attributes and self-close so the
 * content stays human-readable but no longer parses as a section boundary.
 */
export function escapeForPrompt(text: string): string {
    return (text ?? '').replace(
        ANY_TAG_RE,
        (_m, slash: string, tag: string, attrs: string, selfClose: string) => `< ${slash}${tag}${attrs}${selfClose}>`,
    );
}

/**
 * Serialise a value to JSON that is safe to embed in a prompt `<section>`: every
 * `<` / `>` becomes a JSON unicode escape (`<` / `>`). No literal tag
 * survives to forge a section boundary, yet the JSON stays VALID and the model
 * decodes the escapes back to the original characters — so string values inside
 * the object are NOT mutated. (Running `escapeForPrompt` over a serialised JSON
 * string would corrupt any `<…>` inside the data — audit D5-D6 H4.)
 */
export function jsonForPrompt(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
