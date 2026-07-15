// @vitest-environment happy-dom
/**
 * Unit tests for src/ui/utils/oneDriveLinkUtils — docs/plans/onedrive-link-insert.md §9.
 *
 * Coverage:
 *  - buildFileUrl: Windows drive-letter (backslash + forward-slash forms), UNC paths,
 *    POSIX paths, encoding, malformed input -> null.
 *  - formatMarkdownLink: unrepresentable-URL rejection, escaping, angle-bracket wrapping.
 *  - detectOneDriveFolders: isDirectory + isSymbolicLink+statSync fallback, sorted
 *    output, independent try/catch per scan, macOS CloudStorage branch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    buildFileUrl, formatMarkdownLink, detectOneDriveFolders,
    classifyOneDriveEmbed, buildOneDriveEmbedMarkerText, buildOneDriveEmbedBlock, parseOneDriveEmbedMarkers,
} from '../src/ui/utils/oneDriveLinkUtils';

function setRequireImpl(impl: ((mod: string) => unknown) | null): void {
    if (impl === null) {
        delete (globalThis as { require?: unknown }).require;
    } else {
        (globalThis as { require?: (mod: string) => unknown }).require = impl;
    }
}

interface MockDirent {
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
}

function makeDirent(name: string, kind: 'dir' | 'file' | 'symlink'): MockDirent {
    return {
        name,
        isDirectory: () => kind === 'dir',
        isSymbolicLink: () => kind === 'symlink',
    };
}

describe('buildFileUrl', () => {
    it('converts a Windows drive-letter path (backslash form) with encoding', () => {
        expect(buildFileUrl('C:\\Users\\A B\\file.docx')).toBe('file:///C:/Users/A%20B/file.docx');
    });

    it('converts a Windows drive-letter path (forward-slash form) to the same result', () => {
        expect(buildFileUrl('C:/Users/A B/file.docx')).toBe('file:///C:/Users/A%20B/file.docx');
    });

    it('does NOT percent-encode the drive-letter segment itself', () => {
        const url = buildFileUrl('C:\\Users\\file.docx');
        expect(url).not.toContain('%3A');
        expect(url).toContain('C:/');
    });

    it('converts a UNC path to the two-slash host form, distinct from the drive-letter form', () => {
        expect(buildFileUrl('\\\\server\\share\\sub dir\\file.docx')).toBe('file://server/share/sub%20dir/file.docx');
    });

    it('converts a POSIX absolute path with encoding', () => {
        expect(buildFileUrl('/Users/A B/file.docx')).toBe('file:///Users/A%20B/file.docx');
    });

    it('encodes special characters like # and ? and non-ASCII', () => {
        const url = buildFileUrl('/Users/a#b?c/café.docx');
        expect(url).toBe('file:///Users/a%23b%3Fc/caf%C3%A9.docx');
    });

    it('returns null for a relative path', () => {
        expect(buildFileUrl('relative/path.docx')).toBeNull();
    });

    it('returns null for an empty string', () => {
        expect(buildFileUrl('')).toBeNull();
    });
});

describe('formatMarkdownLink', () => {
    it('escapes [ ] and \\ in display text', () => {
        expect(formatMarkdownLink('Report [Q3] (final)', 'https://example.com')).toBe(
            '[Report \\[Q3\\] (final)](https://example.com)'
        );
    });

    it('wraps a URL containing a space in angle brackets', () => {
        expect(formatMarkdownLink('label', 'https://example.com/a b')).toBe('[label](<https://example.com/a b>)');
    });

    it('wraps a URL containing parens in angle brackets', () => {
        expect(formatMarkdownLink('label', 'https://example.com/a(b)c')).toBe('[label](<https://example.com/a(b)c>)');
    });

    it('does not wrap a plain, safe URL', () => {
        expect(formatMarkdownLink('label', 'https://example.com/file')).toBe('[label](https://example.com/file)');
    });

    it('returns null for a URL containing a literal <', () => {
        expect(formatMarkdownLink('label', 'https://example.com/<bad>')).toBeNull();
    });

    it('returns null for a URL containing a literal >', () => {
        expect(formatMarkdownLink('label', 'https://example.com/bad>')).toBeNull();
    });

    it('returns null for a URL containing a control character', () => {
        expect(formatMarkdownLink('label', 'https://example.com/\x01bad')).toBeNull();
    });

    it('returns null for a URL containing a newline', () => {
        expect(formatMarkdownLink('label', 'https://example.com/\nbad')).toBeNull();
    });

    it('round-trips to exactly the intended display text + destination', () => {
        const result = formatMarkdownLink('My File', 'https://example.com/x');
        const match = /^\[(.+)\]\((.+)\)$/.exec(result!);
        expect(match?.[1]).toBe('My File');
        expect(match?.[2]).toBe('https://example.com/x');
    });

    it('passes a file:// URL through and formats normally (scheme-agnostic)', () => {
        expect(formatMarkdownLink('doc.docx', 'file:///C:/Users/doc.docx')).toBe(
            '[doc.docx](file:///C:/Users/doc.docx)'
        );
    });
});

describe('detectOneDriveFolders', () => {
    // audit round-1 L2: a shared afterEach guarantees the mocked global.require
    // is always reset, even if an assertion or implementation throws mid-test —
    // manual cleanup at the end of each test body could otherwise leak into
    // subsequent tests on a failure.
    afterEach(() => setRequireImpl(null));

    it('excludes an unrelated OneDriveBackup-style folder (no real delimiter after "onedrive") (round-1 L1)', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDriveBackup', 'dir')],
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual([]);
    });

    it('detects a folder named OneDrive', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDrive', 'dir'), makeDirent('Documents', 'dir')],
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual(['/home/user/OneDrive']);
    });

    it('detects a folder named OneDrive - Acme Corp (space + hyphen)', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDrive - Acme Corp', 'dir')],
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual(['/home/user/OneDrive - Acme Corp']);
    });

    it('excludes a file (not a directory, not a symlink) named OneDrive.txt', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDrive.txt', 'file')],
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual([]);
    });

    it('detects a OneDrive-named symlink that resolves to a real directory (Gemini gate G1)', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDrive', 'symlink')],
                statSync: () => ({ isDirectory: () => true }),
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual(['/home/user/OneDrive']);
    });

    it('excludes a OneDrive-named broken symlink (statSync throws) without throwing', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDrive', 'symlink')],
                statSync: () => { throw new Error('ENOENT'); },
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(() => detectOneDriveFolders()).not.toThrow();
        expect(detectOneDriveFolders()).toEqual([]);
    });

    it('excludes unrelated folders', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('Documents', 'dir'), makeDirent('Downloads', 'dir')],
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual([]);
    });

    it('returns results in sorted order regardless of raw enumeration order', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => [makeDirent('OneDrive - Zeta', 'dir'), makeDirent('OneDrive - Acme', 'dir')],
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual(['/home/user/OneDrive - Acme', '/home/user/OneDrive - Zeta']);
    });

    it('returns [] (not throws) when readdirSync throws', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'linux' };
            if (mod === 'fs') return {
                readdirSync: () => { throw new Error('EPERM'); },
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(() => detectOneDriveFolders()).not.toThrow();
        expect(detectOneDriveFolders()).toEqual([]);
    });

    it('returns [] when os/fs are unavailable (mobile)', () => {
        setRequireImpl(() => undefined);
        expect(detectOneDriveFolders()).toEqual([]);
    });

    it('scans ~/Library/CloudStorage only on darwin, independently try/caught (round-3 M3)', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/Users/user', platform: () => 'darwin' };
            if (mod === 'fs') return {
                readdirSync: vi.fn((dir: string) => {
                    if (dir === '/Users/user') return [makeDirent('OneDrive', 'dir')];
                    if (dir === '/Users/user/Library/CloudStorage') return [makeDirent('OneDrive-Acme', 'dir')];
                    throw new Error('unexpected dir');
                }),
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders().sort()).toEqual(
            ['/Users/user/Library/CloudStorage/OneDrive-Acme', '/Users/user/OneDrive'].sort()
        );
    });

    it('a failing CloudStorage scan does not discard folders already found in the home-directory scan (round-3 M3)', () => {
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/Users/user', platform: () => 'darwin' };
            if (mod === 'fs') return {
                readdirSync: vi.fn((dir: string) => {
                    if (dir === '/Users/user') return [makeDirent('OneDrive', 'dir')];
                    throw new Error('CloudStorage unavailable');
                }),
            };
            throw new Error(`Unexpected require: ${mod}`);
        });
        expect(detectOneDriveFolders()).toEqual(['/Users/user/OneDrive']);
    });

    it('the CloudStorage branch never runs on non-darwin platforms', () => {
        const readdirSpy = vi.fn((dir: string) => {
            if (dir === '/home/user') return [makeDirent('OneDrive', 'dir')];
            throw new Error(`should not scan ${dir} on non-darwin`);
        });
        setRequireImpl((mod) => {
            if (mod === 'os') return { homedir: () => '/home/user', platform: () => 'win32' };
            if (mod === 'fs') return { readdirSync: readdirSpy };
            throw new Error(`Unexpected require: ${mod}`);
        });
        detectOneDriveFolders();
        expect(readdirSpy).toHaveBeenCalledTimes(1);
    });
});

describe('classifyOneDriveEmbed (onedrive-link-insert extension, brainstormed 2026-07-15)', () => {
    it('classifies PDF as embed', () => {
        expect(classifyOneDriveEmbed('C:\\Users\\a\\report.pdf')).toBe('embed');
    });

    it('classifies common image extensions as embed', () => {
        for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']) {
            expect(classifyOneDriveEmbed(`/a/img.${ext}`)).toBe('embed');
        }
    });

    it('classifies Office formats as vault-link', () => {
        for (const ext of ['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls']) {
            expect(classifyOneDriveEmbed(`/a/deck.${ext}`)).toBe('vault-link');
        }
    });

    it('classification is case-insensitive on the extension', () => {
        expect(classifyOneDriveEmbed('/a/Report.PDF')).toBe('embed');
        expect(classifyOneDriveEmbed('/a/Deck.PPTX')).toBe('vault-link');
    });

    it('falls back to file-url for an unrecognised extension', () => {
        expect(classifyOneDriveEmbed('/a/archive.zip')).toBe('file-url');
    });

    it('falls back to file-url for a path with no extension', () => {
        expect(classifyOneDriveEmbed('/a/README')).toBe('file-url');
    });
});

describe('buildOneDriveEmbedMarkerText / buildOneDriveEmbedBlock / parseOneDriveEmbedMarkers', () => {
    const SOURCE = 'C:\\Users\\alice\\OneDrive\\report.pdf';
    const VAULT = 'AI-Organiser/OneDrive Embeds/report.pdf';
    const MTIME = 1752515000000;

    it('builds a marker comment with source/vault/mtime attributes', () => {
        const marker = buildOneDriveEmbedMarkerText(SOURCE, VAULT, MTIME);
        expect(marker).toBe(`<!-- onedrive-embed: source="${SOURCE}" vault="${VAULT}" mtime="${MTIME}" -->`);
    });

    it('returns null when source contains a literal quote', () => {
        expect(buildOneDriveEmbedMarkerText('C:\\a"b.pdf', VAULT, MTIME)).toBeNull();
    });

    it('returns null when source contains a comment terminator', () => {
        expect(buildOneDriveEmbedMarkerText('C:\\a-->b.pdf', VAULT, MTIME)).toBeNull();
    });

    it('returns null when source contains a control character', () => {
        expect(buildOneDriveEmbedMarkerText('C:\\a\x01b.pdf', VAULT, MTIME)).toBeNull();
    });

    it('builds an embed block with ![[...]] for kind=embed', () => {
        const block = buildOneDriveEmbedBlock(SOURCE, VAULT, MTIME, 'embed');
        expect(block).toBe(
            `<!-- onedrive-embed: source="${SOURCE}" vault="${VAULT}" mtime="${MTIME}" -->\n![[${VAULT}]]`
        );
    });

    it('builds a link block with [[...]] for kind=vault-link', () => {
        const block = buildOneDriveEmbedBlock(SOURCE, VAULT, MTIME, 'vault-link');
        expect(block).toBe(
            `<!-- onedrive-embed: source="${SOURCE}" vault="${VAULT}" mtime="${MTIME}" -->\n[[${VAULT}]]`
        );
    });

    it('buildOneDriveEmbedBlock returns null when the marker itself is unsafe', () => {
        expect(buildOneDriveEmbedBlock('C:\\a"b.pdf', VAULT, MTIME, 'embed')).toBeNull();
    });

    it('parses a single marker back out of note content round-trip', () => {
        const block = buildOneDriveEmbedBlock(SOURCE, VAULT, MTIME, 'embed')!;
        const content = `# Note\n\nSome text.\n\n${block}\n\nMore text.`;
        const markers = parseOneDriveEmbedMarkers(content);
        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({ source: SOURCE, vaultPath: VAULT, mtimeMs: MTIME });
        expect(markers[0].raw).toContain('onedrive-embed');
    });

    it('parses multiple markers in document order', () => {
        const blockA = buildOneDriveEmbedBlock(SOURCE, VAULT, MTIME, 'embed')!;
        const blockB = buildOneDriveEmbedBlock('C:\\b.pptx', 'AI-Organiser/OneDrive Embeds/b.pptx', 999, 'vault-link')!;
        const content = `${blockA}\n\n${blockB}`;
        const markers = parseOneDriveEmbedMarkers(content);
        expect(markers.map((m) => m.vaultPath)).toEqual([VAULT, 'AI-Organiser/OneDrive Embeds/b.pptx']);
    });

    it('returns an empty array when no markers are present', () => {
        expect(parseOneDriveEmbedMarkers('# Just a note\n\nNo embeds here.')).toEqual([]);
    });

    it('regression (live-testing finding 2026-07-15): buildOneDriveEmbedMarkerText rounds a fractional mtimeMs, so the marker always parses back out', () => {
        // fs.Stats.mtimeMs can carry a fractional sub-millisecond component
        // on some filesystems (observed live: 1784046442609.943). The old
        // \d+-only parse regex silently failed to match such a marker,
        // making every embed look like "no OneDrive embeds found" to the
        // refresh command — this locks the fix in both directions.
        const fractionalMtime = 1784046442609.943;
        const marker = buildOneDriveEmbedMarkerText(SOURCE, VAULT, fractionalMtime);
        expect(marker).not.toBeNull();
        expect(marker).toBe(`<!-- onedrive-embed: source="${SOURCE}" vault="${VAULT}" mtime="1784046442610" -->`);

        const parsed = parseOneDriveEmbedMarkers(marker!);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].mtimeMs).toBe(1784046442610);
    });

    it('parseOneDriveEmbedMarkers still parses a marker with an un-rounded fractional mtime (defensive regex widening)', () => {
        const raw = `<!-- onedrive-embed: source="${SOURCE}" vault="${VAULT}" mtime="1784046442609.943" -->`;
        const parsed = parseOneDriveEmbedMarkers(raw);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].mtimeMs).toBeCloseTo(1784046442609.943);
    });
});
