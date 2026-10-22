/**
 * A minimal, dependency-free ZIP writer: entries are stored without compression (method 0), which
 * every unzip tool reads. Used for the small connector bundle (a manifest and one script), where size
 * does not matter and a library would be a dependency for no gain.
 *
 * Deterministic: a fixed timestamp, entries in the order given, UTF-8 names (flag bit 11), so the same
 * input is the same bytes. The end-of-central-directory comment is how a caller marks a file as theirs.
 */

export interface ZipEntry {
    /** Forward-slash path inside the archive, no leading slash, no `..` */
    name: string;
    data: Uint8Array;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00 in DOS format: a fixed value keeps the output deterministic.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

class Writer {
    private readonly parts: Uint8Array[] = [];
    length = 0;
    u16(v: number): void { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
    u32(v: number): void { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
    push(b: Uint8Array): void { this.parts.push(b); this.length += b.length; }
    bytes(): Uint8Array {
        const out = new Uint8Array(this.length);
        let at = 0;
        for (const p of this.parts) { out.set(p, at); at += p.length; }
        return out;
    }
}

const isSafeName = (name: string): boolean =>
    name !== '' && !name.startsWith('/') && !name.includes('\\') && !name.includes('\u0000') && !name.split('/').some((s) => s === '' || s === '.' || s === '..');

/** Build the archive. Throws on an unsafe name or a size the classic format cannot hold. */
export function buildZip(entries: readonly ZipEntry[], comment = ''): Uint8Array {
    const encoder = new TextEncoder();
    const commentBytes = encoder.encode(comment);
    if (entries.length > MAX_U16 || commentBytes.length > MAX_U16) throw new Error('zip: too many entries or comment too long');
    const out = new Writer();
    const central = new Writer();
    const seen = new Set<string>();
    for (const entry of entries) {
        if (!isSafeName(entry.name) || seen.has(entry.name)) throw new Error(`zip: unsafe or duplicate name ${entry.name}`);
        seen.add(entry.name);
        const name = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const size = entry.data.length;
        if (size > MAX_U32 || out.length > MAX_U32) throw new Error('zip: too large');
        const offset = out.length;

        out.u32(0x04034b50); out.u16(20); out.u16(UTF8_FLAG); out.u16(0); out.u16(DOS_TIME); out.u16(DOS_DATE);
        out.u32(crc); out.u32(size); out.u32(size); out.u16(name.length); out.u16(0);
        out.push(name); out.push(entry.data);

        central.u32(0x02014b50); central.u16(20); central.u16(20); central.u16(UTF8_FLAG); central.u16(0); central.u16(DOS_TIME); central.u16(DOS_DATE);
        central.u32(crc); central.u32(size); central.u32(size); central.u16(name.length); central.u16(0); central.u16(0);
        central.u16(0); central.u16(0); central.u32(0); central.u32(offset);
        central.push(name);
    }
    const centralStart = out.length;
    out.push(central.bytes());
    out.u32(0x06054b50); out.u16(0); out.u16(0); out.u16(entries.length); out.u16(entries.length);
    out.u32(central.length); out.u32(centralStart); out.u16(commentBytes.length);
    out.push(commentBytes);
    return out.bytes();
}

/** The archive comment, read from the end of a ZIP (null when it is not a ZIP we can read). */
export function readZipComment(zip: Uint8Array): string | null {
    // The end record is 22 bytes plus a comment of at most 65 535 bytes.
    const start = Math.max(0, zip.length - 22 - MAX_U16);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = zip.length - 22; i >= start; i--) {
        if (view.getUint32(i, true) !== 0x06054b50) continue;
        const len = view.getUint16(i + 20, true);
        if (i + 22 + len !== zip.length) continue;
        return new TextDecoder().decode(zip.subarray(i + 22, i + 22 + len));
    }
    return null;
}
