/**
 * Normalise an Obsidian frontmatter `tags` value into a string[].
 *
 * The YAML parser auto-coerces values, so a note authored as
 *   ```yaml
 *   tags: 2026
 *   ```
 * yields `cache.frontmatter.tags === 2026` (number), and
 *   ```yaml
 *   tags:
 *     - 2026
 *     -
 *     - "#draft"
 *   ```
 * yields `[2026, null, "#draft"]` (heterogeneous array with nulls).
 *
 * Production code that called `(t: string) => t.replace(/^#/, '')` on those
 * shapes crashed with `replace is not a function` (numbers) or
 * `Cannot read properties of null` (null entries), aborting vault-wide
 * passes like `VectorStoreService.indexAll` or
 * `SelectionService.getSelectionCount` and cascading into modal-render
 * failures. This helper coerces defensively: null/undefined entries are
 * skipped, everything else is `String(raw)`-coerced and stripped of the
 * leading `#`.
 *
 * @param fmTags - the raw `cache.frontmatter.tags` value (any shape)
 * @returns array of tag strings without `#` prefix, in original order
 */
export function normaliseFrontmatterTags(fmTags: unknown): string[] {
    if (fmTags == null) return [];
    const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
    const out: string[] = [];
    for (const raw of arr) {
        if (raw == null) continue;
        const asStr = typeof raw === 'string' ? raw : String(raw);
        out.push(asStr.replace(/^#/, ''));
    }
    return out;
}
