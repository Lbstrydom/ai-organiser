/**
 * Attachment helper: "suggest a home note" and "link to note".
 *
 * Suggest-home proposes up to three notes an unreferenced attachment could be linked from. It
 * never acts: the user clicks Link. With semantic search on, the first 1,000 characters of the
 * attachment's extracted text are used as the query (so a PDF's text goes to the embedding
 * provider). When that provider is external, the user is asked once per session and can choose
 * the basic title-word match instead, which sends nothing anywhere. No LLM generation is involved.
 *
 * Link-to-note appends `![[path]]` under a heading (default "Attachments") through
 * `applyNoteEdit`, so protected folders are refused by the write seam. It is idempotent: if the
 * note already links the file, nothing is written.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok, err } from '../core/result';
import { isProtectedPath } from '../core/protectedPaths';
import { getPluginManagedFolders } from '../core/settings';
import { isFeatureEnabled } from './featureService';
import { applyNoteEdit, type CompositeTarget } from './noteEdit/applyNoteEdit';
import type { ApplyOutcome } from './noteEdit/noteWritePort';

/** Characters of extracted text used as the semantic query. */
export const HOME_QUERY_CHARS = 1000;
const TOP_K = 3;

export interface HomeCandidate {
    path: string;
    title: string;
    score: number;
    method: 'semantic' | 'basic';
    /** True when the note sits in a protected folder and cannot be linked */
    protected: boolean;
}

export interface HomeSuggestion {
    candidates: HomeCandidate[];
    method: 'semantic' | 'basic';
    /** True when the user was asked and chose the basic match instead of sending text out */
    egressDeclined: boolean;
}

/** Everything suggest-home needs, injectable for tests. */
export interface HomeContext {
    protectedFolders: readonly string[];
    /** Candidate notes (vault paths) */
    markdownPaths(): string[];
    /** Notes the user allows as a home (excludes plugin output and user-excluded folders) */
    isAllowed(path: string): boolean;
    /** Extracted text for the attachment, or null when it has none */
    readText(path: string): Promise<string | null>;
    /** Ranked note paths for a query (best first), or undefined when semantic search is unavailable */
    semanticSearch?: (query: string, topK: number) => Promise<string[]>;
    /** True when building the query vector sends text to a cloud provider */
    embeddingIsExternal: boolean;
    /** Ask once per session; resolves true to send, false for the basic match */
    confirmEgress?: () => Promise<boolean>;
}

// ─── Basic title-word match (pure) ───────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'pdf', 'png', 'jpg', 'jpeg', 'docx', 'xlsx', 'pptx', 'img', 'scan', 'file']);

/** Lower-case word tokens (letters and digits, any script), short and stop words removed. */
export function titleTokens(text: string): Set<string> {
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !STOP.has(t));
    return new Set(tokens);
}

/** Rank notes by how many of their title / folder words appear in the attachment's name and text. */
export function rankByTitleOverlap(
    attachmentName: string,
    snippet: string,
    notePaths: readonly string[],
): { path: string; score: number }[] {
    const query = titleTokens(`${attachmentName} ${snippet}`);
    if (query.size === 0) return [];
    const scored: { path: string; score: number }[] = [];
    for (const path of notePaths) {
        const noteTokens = titleTokens(path.replace(/\.md$/i, ''));
        if (noteTokens.size === 0) continue;
        let overlap = 0;
        for (const t of noteTokens) if (query.has(t)) overlap++;
        if (overlap > 0) scored.push({ path, score: overlap / noteTokens.size });
    }
    return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function titleOf(path: string): string {
    const name = path.split('/').pop() ?? path;
    return name.replace(/\.md$/i, '');
}

/** Suggest up to three home notes. Never throws. */
export async function suggestHomes(ctx: HomeContext, attachmentPath: string): Promise<Result<HomeSuggestion>> {
    try {
        const allowed = ctx.markdownPaths().filter((p) => ctx.isAllowed(p));
        const text = (await ctx.readText(attachmentPath)) ?? '';
        const snippet = text.slice(0, HOME_QUERY_CHARS);
        const name = attachmentPath.split('/').pop() ?? attachmentPath;

        let egressDeclined = false;
        let semanticPaths: string[] | null = null;
        if (ctx.semanticSearch && snippet.trim() !== '') {
            let allowedToSend = true;
            if (ctx.embeddingIsExternal) {
                allowedToSend = ctx.confirmEgress ? await ctx.confirmEgress() : false;
                egressDeclined = !allowedToSend;
            }
            if (allowedToSend) {
                const ranked = await ctx.semanticSearch(snippet, TOP_K * 4);
                const allowedSet = new Set(allowed);
                const seen = new Set<string>();
                semanticPaths = [];
                for (const p of ranked) {
                    if (allowedSet.has(p) && !seen.has(p)) {
                        seen.add(p);
                        semanticPaths.push(p);
                    }
                }
            }
        }

        const toCandidate = (path: string, score: number, method: 'semantic' | 'basic'): HomeCandidate => ({
            path,
            title: titleOf(path),
            score,
            method,
            protected: isProtectedPath(ctx.protectedFolders, path),
        });

        if (semanticPaths && semanticPaths.length > 0) {
            const n = semanticPaths.length;
            return ok({
                candidates: semanticPaths.slice(0, TOP_K).map((p, i) => toCandidate(p, 1 - i / Math.max(n, 1), 'semantic')),
                method: 'semantic',
                egressDeclined,
            });
        }
        const basic = rankByTitleOverlap(name, snippet, allowed).slice(0, TOP_K);
        return ok({
            candidates: basic.map((b) => toCandidate(b.path, b.score, 'basic')),
            method: 'basic',
            egressDeclined,
        });
    } catch {
        return err('scan-incomplete');
    }
}

/** Build the live context from the plugin. */
export function createHomeContext(
    plugin: AIOrganiserPlugin,
    confirmEgress: () => Promise<boolean>,
): HomeContext {
    const settings = plugin.settings;
    const managed = getPluginManagedFolders(settings).map((f) => f.toLowerCase());
    const excluded = (settings.excludedFolders ?? []).map((f) => f.toLowerCase());
    const external = !['ollama', 'local-onnx'].includes(settings.embeddingProvider);
    const search = plugin.vectorStoreService;
    const semanticOn = !!search && !!plugin.vectorStore && isFeatureEnabled(settings, 'semantic-search');
    return {
        protectedFolders: settings.protectedFolders,
        markdownPaths: () => plugin.app.vault.getMarkdownFiles().map((f) => f.path),
        isAllowed: (path) => {
            const lower = path.toLowerCase();
            return ![...managed, ...excluded].some((f) => f !== '' && (lower === f || lower.startsWith(f + '/')));
        },
        readText: async (path) => {
            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return null;
            if (file.extension === 'md' || file.extension === 'txt') {
                try { return await plugin.app.vault.cachedRead(file); } catch { return null; }
            }
            const res = await plugin.documentExtractionService.extractText(file);
            return res.success && res.text ? res.text : null;
        },
        semanticSearch: semanticOn
            ? async (query, topK) => (await search.search(query, topK)).map((r) => r.document.filePath)
            : undefined,
        embeddingIsExternal: external,
        confirmEgress,
    };
}

// ─── Link to note ────────────────────────────────────────────────────────────

/**
 * Mark the lines that are not Markdown body: leading YAML frontmatter and fenced code. A fence is
 * closed only by a fence of the same character that is at least as long as the opening one and has
 * no text after it (CommonMark), so a `~~~` line inside a backtick fence does not end it.
 */
export function nonBodyLines(lines: readonly string[]): boolean[] {
    const out = new Array<boolean>(lines.length).fill(false);
    let i = 0;
    if (lines.length > 0 && lines[0].trim() === '---') {
        for (let j = 1; j < lines.length; j++) {
            if (lines[j].trim() === '---' || lines[j].trim() === '...') {
                for (let k = 0; k <= j; k++) out[k] = true;
                i = j + 1;
                break;
            }
        }
    }
    let fence: { ch: string; len: number } | null = null;
    for (; i < lines.length; i++) {
        const m = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (!fence) {
            // A backtick fence cannot have a backtick in its info string (that is inline code).
            if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
                fence = { ch: m[1][0], len: m[1].length };
                out[i] = true;
            }
            continue;
        }
        out[i] = true;
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
    }
    return out;
}

/** True when the last line is still inside an open fenced code block. */
function endsInsideFence(lines: readonly string[]): boolean {
    let fence: { ch: string; len: number } | null = null;
    const start = lines.length > 0 && lines[0].trim() === '---' ? lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...')) + 1 : 0;
    for (let i = Math.max(0, start); i < lines.length; i++) {
        const m = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (!fence) {
            if (m && !(m[1][0] === '`' && m[2].includes('`'))) fence = { ch: m[1][0], len: m[1].length };
            continue;
        }
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
    }
    return fence !== null;
}

/** Link text of every wiki link or embed in `text` (alias and subpath removed), outside code and frontmatter. */
function wikiLinkTargets(text: string): string[] {
    const targets: string[] = [];
    const lines = text.split('\n');
    const skip = nonBodyLines(lines);
    for (let i = 0; i < lines.length; i++) {
        if (skip[i]) continue;
        // Inline code spans are not links.
        const visible = lines[i].replace(/(`+)[^`]*?\1/g, '');
        for (const m of visible.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
            targets.push(m[1].split('|')[0].split('#')[0].trim());
        }
    }
    return targets;
}

/**
 * True when `text` already links or embeds the file. With a `resolve` function (link text →
 * vault path, resolved from the destination note) the comparison is by canonical target, so a
 * same-named file in another folder does not count. Without one, only the full path matches.
 */
export function alreadyLinks(text: string, filePath: string, resolve?: (linktext: string) => string | null): boolean {
    const wanted = filePath.toLowerCase();
    return wikiLinkTargets(text).some((target) => {
        if (target.toLowerCase() === wanted) return true;
        if (!resolve) return false;
        const resolved = resolve(target);
        return resolved !== null && resolved.toLowerCase() === wanted;
    });
}

/**
 * Pure transform: append `![[filePath]]` under the heading, creating the heading at the end of
 * the note when it is missing. The heading matches at any level, case-insensitively.
 */
export function appendAttachmentLink(
    current: string,
    filePath: string,
    heading: string,
    resolve?: (linktext: string) => string | null,
): Result<ApplyOutcome> {
    if (alreadyLinks(current, filePath, resolve)) return ok({ content: current, info: 'already-linked' });
    const link = `![[${filePath}]]`;
    const lines = current.split('\n');
    // Headings inside frontmatter or fenced code blocks are not headings.
    const fencedLine = nonBodyLines(lines);
    // A fence that never closes swallows the rest of the note: appending there would put the link
    // inside the code block, so refuse rather than write something that does not read as a link.
    if (lines.length > 0 && endsInsideFence(lines)) return err('link-failed');
    const headingRe = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*#*\\s*$`, 'i');
    const start = lines.findIndex((l, i) => !fencedLine[i] && headingRe.test(l));
    if (start === -1) {
        const body = current.replace(/\s+$/, '');
        const prefix = body === '' ? '' : body + '\n\n';
        return ok({ content: `${prefix}## ${heading}\n${link}\n`, info: 'heading-created' });
    }
    const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (fencedLine[i]) continue;
        const m = lines[i].match(/^(#{1,6})\s+\S/);
        if (m && m[1].length <= level) { end = i; break; }
    }
    // Insert after the last non-blank line of the section.
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, link);
    return ok({ content: lines.join('\n') });
}

/**
 * Link an attachment from a note. Returns `{ changed: false }` without writing when the note
 * already links it. Protected notes are refused by the write seam (`protected-path`).
 */
export async function linkToNote(
    plugin: AIOrganiserPlugin,
    attachmentPath: string,
    notePath: string,
    heading: string,
): Promise<Result<{ changed: boolean }>> {
    const note = plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) return err('target-missing');
    let baseline: string;
    try {
        baseline = await plugin.app.vault.read(note);
    } catch {
        return err('target-missing');
    }
    // Resolve existing links from the destination note's own position (same-named files elsewhere do not count).
    const resolve = (linktext: string): string | null =>
        plugin.app.metadataCache.getFirstLinkpathDest(linktext, notePath)?.path ?? null;
    if (alreadyLinks(baseline, attachmentPath, resolve)) return ok({ changed: false });
    const target: CompositeTarget = {
        kind: 'composite',
        filePath: notePath,
        baseline,
        recompute: (current) => appendAttachmentLink(current, attachmentPath, heading, resolve),
    };
    // The user's click on "Link" is the approval, so no second review modal.
    const res = await applyNoteEdit(plugin, target, { review: false });
    if (!res.ok) return err(res.error === 'protected-path' ? 'protected-path' : 'link-failed');
    return ok({ changed: true });
}
