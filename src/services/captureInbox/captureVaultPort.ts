/**
 * The Obsidian-backed ports for the scanner and the processor. Reads only: nothing in this file
 * writes, renames or deletes.
 *
 * Link resolution has two modes. With the note's text (a note being read) the links are parsed from
 * that same text; without it (a kept-out note that must NOT be read) the answer comes from Obsidian's
 * link index alone. Either way an embed that does not resolve yet is reported when it names media,
 * because an attachment can arrive after its note.
 */
import { TFile, type App } from 'obsidian';
import { sha256Hex } from '../attachmentDuplicateService';
import { classifyByExtension, extensionOf, isKnownUnsupportedMedia } from './mediaSignature';
import type { CaptureVaultPort, ResolvedAttachments, VaultFileInfo } from './captureScanner';
import type { ProcessorPort } from './captureProcessor';

// Every class is bounded and stops at a newline: an unclosed bracket costs a short scan, never the rest of the note.
const WIKI = /!?\[\[([^\]\n]{1,300})\]\]/g;
const MD_LINK = /!?\[[^\]\n]{0,300}\]\(\s*(?:<([^>\n]{1,500})>|([^)\s]{1,500}))(?:\s+"[^"\n]{0,300}")?\s*\)/g;

/** The link targets named in note text: wiki links and markdown links, alias and heading stripped. */
/**
 * The note text with fenced code blocks and inline code removed. Link-looking text inside code is literal text, not an
 * attachment: `![[clip.m4a]]` shown in a code fence must not pull that file into a capture.
 */
export function withoutCode(text: string): string {
    const out: string[] = [];
    let fence: { char: string; len: number } | null = null;
    for (const line of text.split('\n')) {
        const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence === null) {
            if (m) {
                fence = { char: m[1][0], len: m[1].length };
                out.push('');
                continue;
            }
            out.push(line.replace(/`[^`\n]{0,300}`/g, ' '));
        } else {
            if (m && m[1][0] === fence.char && m[1].length >= fence.len && /^\s{0,3}[`~]+\s*$/.test(line)) fence = null;
            out.push('');
        }
    }
    return out.join('\n');
}

export function extractLinkTargets(rawText: string): string[] {
    const text = withoutCode(rawText);
    const found = new Set<string>();
    for (const m of text.matchAll(WIKI)) found.add(m[1].split('|')[0].split('#')[0].trim());
    for (const m of text.matchAll(MD_LINK)) {
        let target = m[1] ?? m[2];
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
        try {
            target = decodeURIComponent(target);
        } catch {
            // keep the raw target
        }
        found.add(target.split('#')[0].trim());
    }
    found.delete('');
    return [...found];
}

const looksLikeMedia = (name: string): boolean => classifyByExtension(name) !== null || isKnownUnsupportedMedia(name);

export function createVaultPort(app: App): CaptureVaultPort & ProcessorPort {
    const digests = new Map<string, string>();
    let reverse: { at: number; map: Map<string, string[]> } | null = null;
    const reverseMap = (): Map<string, string[]> => {
        const now = Date.now();
        if (reverse && now - reverse.at < 2000) return reverse.map;
        const map = new Map<string, string[]>();
        for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
            for (const target of Object.keys(targets)) {
                const list = map.get(target);
                if (list) list.push(source);
                else map.set(target, [source]);
            }
        }
        reverse = { at: now, map };
        return map;
    };

    return {
        listFiles(): VaultFileInfo[] {
            return app.vault.getFiles().map((f) => ({ path: f.path, extension: f.extension, ctime: f.stat.ctime, mtime: f.stat.mtime, size: f.stat.size }));
        },
        async readText(path: string): Promise<string> {
            const file = app.vault.getAbstractFileByPath(path);
            return file instanceof TFile ? app.vault.read(file) : '';
        },
        resolveAttachments(notePath: string, text?: string): ResolvedAttachments {
            let targets: string[];
            if (text !== undefined) {
                targets = extractLinkTargets(text);
            } else {
                const cache = app.metadataCache.getCache(notePath);
                targets = [...(cache?.embeds ?? []), ...(cache?.links ?? [])].map((l) => l.link.split('#')[0].trim()).filter(Boolean);
            }
            const resolved: string[] = [];
            const unresolvedMedia: string[] = [];
            for (const target of new Set(targets)) {
                const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
                if (dest) {
                    if (!resolved.includes(dest.path)) resolved.push(dest.path);
                } else if (looksLikeMedia(target) && extensionOf(target) !== '') {
                    unresolvedMedia.push(target);
                }
            }
            return { resolved, unresolvedMedia };
        },
        referrersOf(path: string): string[] {
            return reverseMap().get(path) ?? [];
        },
        async digestOf(path: string, size: number, mtime: number): Promise<string | null> {
            const key = `${path}|${size}|${mtime}`;
            const hit = digests.get(key);
            if (hit !== undefined) return hit;
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return null;
            try {
                const digest = await sha256Hex(await app.vault.readBinary(file));
                // Only the latest digest per path is kept: the cache is a memory of what was already read, not an archive.
                for (const k of digests.keys()) if (k.startsWith(`${path}|`)) digests.delete(k);
                digests.set(key, digest);
                return digest;
            } catch {
                return null;
            }
        },
        async readBytes(path: string): Promise<Uint8Array> {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return new Uint8Array(0);
            return new Uint8Array(await app.vault.readBinary(file));
        },
        async stat(path: string): Promise<{ size: number; mtime: number } | null> {
            const stat = await app.vault.adapter.stat(path);
            return stat ? { size: stat.size, mtime: stat.mtime } : null;
        },
        exists(path: string): boolean {
            return app.vault.getAbstractFileByPath(path) !== null;
        },
    };
}
