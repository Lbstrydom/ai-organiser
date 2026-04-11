/**
 * Shared utilities for NotebookLM export
 *
 * Extracted from sourcePackService.ts and writer.ts to eliminate duplication (B1).
 */

/**
 * Format a byte count as a human-readable string (e.g. "1.2 MB").
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Sanitize a note title or filename for use as an export filename.
 * Removes/replaces characters invalid on Windows, macOS, and Linux.
 */
export function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '-')   // Replace invalid chars
        .replace(/\s+/g, '_')              // Replace spaces with underscores
        .replace(/-+/g, '-')               // Collapse multiple dashes
        .replace(/(^-)|(-$)/g, '')         // Trim leading/trailing dashes
        .slice(0, 200);                    // Limit length
}

/**
 * Resolve a collision-safe output filename within a shared `used` set.
 * Appends an incrementing counter (-2, -3…) until a unique name is found.
 * Both notes and sidecars share the same `used` set within one pack export.
 *
 * @param baseName  - Unsanitized note title or file basename (without extension)
 * @param ext       - File extension without leading dot (e.g. "txt", "pdf")
 * @param used      - Set of already-claimed lower-cased filenames; mutated in place
 */
export function resolveOutputName(baseName: string, ext: string, used: Set<string>): string {
    const base = sanitizeFilename(baseName);
    let candidate = `${base}.${ext}`;
    let counter = 2;
    while (used.has(candidate.toLowerCase()) && counter <= 999) {
        candidate = `${base}-${counter}.${ext}`;
        counter++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}
