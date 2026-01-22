export function isYouTubeUrl(text: string): boolean {
    if (!text) return false;
    return /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/)/i.test(text);
}

export function isPdfLink(text: string): boolean {
    if (!text) return false;
    if (/\[\[[^\]]+\.pdf(?:\|[^\]]*)?\]\]/i.test(text)) return true;
    if (/!\[\[[^\]]+\.pdf(?:\|[^\]]*)?\]\]/i.test(text)) return true;
    return /https?:\/\/\S+\.pdf(?:\?\S+)?/i.test(text);
}

export function isUrl(text: string): boolean {
    if (!text) return false;
    return /https?:\/\/\S+/i.test(text);
}

export function extractUrl(text: string): string | null {
    if (!text) return null;
    const match = text.match(/https?:\/\/\S+/i);
    return match ? match[0] : null;
}

export function extractPdfPath(text: string): string | null {
    if (!text) return null;
    const wikiMatch = text.match(/!?\[\[([^\]|]+\.pdf)(?:\|[^\]]*)?\]\]/i);
    if (wikiMatch) {
        return wikiMatch[1];
    }

    const urlMatch = text.match(/https?:\/\/\S+\.pdf(?:\?\S+)?/i);
    if (urlMatch) {
        return urlMatch[0];
    }

    return null;
}
