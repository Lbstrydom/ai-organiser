/**
 * Media validation from bytes already in memory: extension class plus a magic-byte check, so a
 * truncated, renamed or zero-byte file is refused BEFORE anything is uploaded. Pure.
 */
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS } from '../../core/constants';

export type MediaKind = 'audio' | 'image';

const AUDIO = new Set(AUDIO_EXTENSIONS.map((e) => e.slice(1)));
/** SVG is markup, not a photo: it is not a capture. */
const IMAGE = new Set(IMAGE_EXTENSIONS.map((e) => e.slice(1)).filter((e) => e !== 'svg'));

export type SignatureResult =
    | { ok: true; kind: MediaKind }
    | { ok: false; reason: 'unsupported' | 'empty' | 'mismatch' };

export function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The class of a file judged by extension alone (readiness checks; no bytes needed). */
export function classifyByExtension(path: string): MediaKind | null {
    const ext = extensionOf(path);
    if (AUDIO.has(ext)) return 'audio';
    if (IMAGE.has(ext)) return 'image';
    return null;
}

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
    if (b.length < at + text.length) return false;
    for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
    return true;
};

function matches(ext: string, b: Uint8Array): boolean {
    switch (ext) {
        case 'mp3':
        case 'mpeg':
        case 'mpga':
            return ascii(b, 0, 'ID3') || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
        case 'wav':
            return ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE');
        case 'm4a':
        case 'mp4':
            // Most files open with `ftyp`; some recorders write a `wide`, `free` or `moov` atom first.
            return ascii(b, 4, 'ftyp') || ascii(b, 4, 'wide') || ascii(b, 4, 'free') || ascii(b, 4, 'moov') || ascii(b, 4, 'mdat');
        case 'heic':
        case 'heif':
        case 'avif':
            return ascii(b, 4, 'ftyp');
        case 'ogg':
        case 'oga':
            return ascii(b, 0, 'OggS');
        case 'webm':
            return b.length > 3 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
        case 'png':
            return b.length > 3 && b[0] === 0x89 && ascii(b, 1, 'PNG');
        case 'jpg':
        case 'jpeg':
            return b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        case 'gif':
            return ascii(b, 0, 'GIF8');
        case 'webp':
            return ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP');
        case 'bmp':
            return ascii(b, 0, 'BM');
        case 'tif':
        case 'tiff':
            return (ascii(b, 0, 'II') && b[2] === 0x2a && b[3] === 0) || (ascii(b, 0, 'MM') && b[2] === 0 && b[3] === 0x2a);
        default:
            return false;
    }
}

/** Formats a voice or photo app commonly produces that the transcription / vision pipelines cannot read. */
const KNOWN_UNSUPPORTED = new Set(['caf', '3gp', '3gpp', 'amr', 'aac', 'flac', 'opus', 'wma', 'aiff', 'aif', 'mov', 'avi', 'mkv']);

/** True for a media file we recognise but cannot process (named to the user instead of silently ignored). */
export function isKnownUnsupportedMedia(path: string): boolean {
    return KNOWN_UNSUPPORTED.has(extensionOf(path));
}

/** Validate the bytes of a file named `path`. Never throws. */
export function checkSignature(path: string, bytes: Uint8Array): SignatureResult {
    const kind = classifyByExtension(path);
    if (!kind) return { ok: false, reason: 'unsupported' };
    if (bytes.length === 0) return { ok: false, reason: 'empty' };
    return matches(extensionOf(path), bytes) ? { ok: true, kind } : { ok: false, reason: 'mismatch' };
}
