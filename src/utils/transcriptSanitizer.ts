/**
 * Transcript paste sanitizer
 * --------------------------
 * Strips artifacts from Office/Word HTML clipboard content that would survive
 * through a plain-text paste and into the LLM prompt / output note — most
 * notably `file:///.../msohtmlclip1/.../clip_imageXXX.gif` references that
 * Obsidian's CSP blocks with noisy console spam and can lock the UI when
 * hundreds of them are present (user report 2026-04-23).
 *
 * Rules:
 *   - Remove markdown image syntax targeting file:/// URIs
 *   - Remove raw file:/// URLs (any scheme)
 *   - Remove <img src="..."> tags pointing at local file refs
 *   - Remove repeated `clip_imageNNN` filename fragments that textarea paste
 *     occasionally leaves bare
 *   - Collapse resulting whitespace runs to at most one blank line
 */

const FILE_URL = /file:\/\/\/?[^\s)"'<>]*/gi;
const MD_IMAGE_FILE = /!\[[^\]]*]\(file:\/\/\/?[^)]*\)/gi;
const HTML_IMG_FILE = /<img[^>]+src=["']?file:\/\/\/?[^"'>\s]*["']?[^>]*>/gi;
const CLIP_IMAGE_BARE = /\bclip_image\d+(?:\.[a-z0-9]+)?\b/gi;

export function sanitizeTranscriptPaste(input: string): string {
    if (!input) return input;
    let out = input;
    out = out.replace(MD_IMAGE_FILE, '');
    out = out.replace(HTML_IMG_FILE, '');
    out = out.replace(FILE_URL, '');
    out = out.replace(CLIP_IMAGE_BARE, '');
    // Collapse 3+ newlines to 2 so paragraph breaks survive but image-ref
    // removal doesn't leave towers of blank lines.
    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
}
