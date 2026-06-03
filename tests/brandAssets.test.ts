// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    normalizeBrandConcept, getBrandFolder, getLogo, getBrandIcon, clearBrandAssetCache,
    setBrandSvgRasterizer,
} from '../src/services/export/brand/brandAssets';
import { createTFile } from './mocks/obsidian';
import type { App } from 'obsidian';
import type { AIOrganiserSettings } from '../src/core/settings';

const SETTINGS = { brandFolderPath: '999_Brand' } as unknown as AIOrganiserSettings;

interface FileSpec { content?: string; size?: number; mtime?: number; binary?: ArrayBuffer }

/** Build an App whose vault serves a fixed map of path → file spec. */
function makeApp(files: Record<string, FileSpec>): App {
    const tfiles = new Map<string, ReturnType<typeof createTFile>>();
    for (const [path, spec] of Object.entries(files)) {
        const f = createTFile(path);
        f.stat = { mtime: spec.mtime ?? 1, ctime: 1, size: spec.size ?? (spec.content?.length ?? 100) };
        tfiles.set(path, f);
    }
    return {
        vault: {
            getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
            cachedRead: async (f: { path: string }) => files[f.path]?.content ?? '',
            readBinary: async (f: { path: string }) => files[f.path]?.binary ?? new ArrayBuffer(4),
        },
    } as unknown as App;
}

beforeEach(() => {
    clearBrandAssetCache();
    // happy-dom has no real canvas raster; echo the (sanitized + recoloured) SVG
    // back inside a fake PNG data-URI so tests can still assert the markup that
    // reached the rasterizer. Real raster is exercised separately.
    setBrandSvgRasterizer(async (svg) => `data:image/png;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`);
});

/** Decode the SVG markup echoed into our fake-raster PNG data-URI. */
function decodeRaster(uri: string): string {
    const b64 = uri.replace(/^data:image\/png;base64,/, '');
    return Buffer.from(b64, 'base64').toString('utf-8');
}

describe('normalizeBrandConcept', () => {
    it('lowercases, trims, hyphenates', () => {
        expect(normalizeBrandConcept('  Carbon Capture ')).toBe('carbon-capture');
        expect(normalizeBrandConcept('Power_Grid')).toBe('power-grid');
        expect(normalizeBrandConcept('A&B!!C')).toBe('abc');
        expect(normalizeBrandConcept('--edge--')).toBe('edge');
        expect(normalizeBrandConcept('')).toBe('');
    });
});

describe('getBrandFolder', () => {
    it('uses the setting when present', () => {
        expect(getBrandFolder(SETTINGS)).toBe('999_Brand');
    });
    it('falls back to the default when absent', () => {
        expect(getBrandFolder({} as AIOrganiserSettings)).toBe('999_Brand');
    });
    it('normalises backslashes + strips leading/trailing slashes (audit M22)', () => {
        expect(getBrandFolder({ brandFolderPath: '\\Brand\\Sub\\' } as unknown as AIOrganiserSettings)).toBe('Brand/Sub');
        expect(getBrandFolder({ brandFolderPath: '/Brand/Sub/' } as unknown as AIOrganiserSettings)).toBe('Brand/Sub');
        expect(getBrandFolder({ brandFolderPath: '  Brand\\Nested  ' } as unknown as AIOrganiserSettings)).toBe('Brand/Nested');
    });
});

describe('getLogo', () => {
    it('returns a png data-uri when logo-light.png exists', async () => {
        const app = makeApp({ '999_Brand/logo-light.png': { binary: new Uint8Array([1, 2, 3]).buffer } });
        const uri = await getLogo(app, SETTINGS, 'light');
        expect(uri).toMatch(/^data:image\/png;base64,/);
    });
    it('rasterizes to a png when only svg exists', async () => {
        const app = makeApp({ '999_Brand/logo-dark.svg': { content: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' } });
        const uri = await getLogo(app, SETTINGS, 'dark');
        expect(uri).toMatch(/^data:image\/png;base64,/);
    });
    it('returns null when absent', async () => {
        expect(await getLogo(makeApp({}), SETTINGS, 'light')).toBeNull();
    });
});

describe('getBrandIcon', () => {
    const goodSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1"/></svg>';

    it('resolves a direct icons/<concept>.svg', async () => {
        const app = makeApp({ '999_Brand/icons/energy.svg': { content: goodSvg } });
        const uri = await getBrandIcon(app, SETTINGS, 'Energy', 'light');
        expect(uri).toMatch(/^data:image\/png;base64,/);
    });

    it('uses the manifest mapping when present', async () => {
        const app = makeApp({
            '999_Brand/icons/manifest.json': { content: JSON.stringify({ energy: 'corp-power.svg' }) },
            '999_Brand/icons/corp-power.svg': { content: goodSvg },
        });
        const uri = await getBrandIcon(app, SETTINGS, 'energy', 'dark');
        expect(uri).toMatch(/^data:image\/png;base64,/);
    });

    it('recolours the dark variant → brand ink, light variant → white', async () => {
        const inkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" stroke="#000000" d="M1 1"/></svg>';
        const app = makeApp({ '999_Brand/icons/leaf.svg': { content: inkSvg } });
        const dark = decodeRaster((await getBrandIcon(app, SETTINGS, 'leaf', 'dark'))!);
        expect(dark).toContain('#1A1A2E');
        expect(dark).not.toContain('currentColor');
        const light = decodeRaster((await getBrandIcon(app, SETTINGS, 'leaf', 'light'))!);
        expect(light).toContain('#FFFFFF');
    });

    it('returns null for an absent concept', async () => {
        expect(await getBrandIcon(makeApp({}), SETTINGS, 'missing', 'light')).toBeNull();
    });

    it('returns null for an empty concept', async () => {
        expect(await getBrandIcon(makeApp({}), SETTINGS, '   ', 'light')).toBeNull();
    });

    it('fails closed on a malicious SVG (script stripped → still safe data-uri, no script)', async () => {
        const evil = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M1 1"/></svg>';
        const app = makeApp({ '999_Brand/icons/x.svg': { content: evil } });
        const uri = await getBrandIcon(app, SETTINGS, 'x', 'light');
        expect(uri).not.toBeNull();
        expect(decodeRaster(uri!)).not.toContain('<script');
    });

    it('returns null when the rasterizer fails (fail-closed)', async () => {
        setBrandSvgRasterizer(async () => null);
        const app = makeApp({ '999_Brand/icons/energy.svg': { content: goodSvg } });
        expect(await getBrandIcon(app, SETTINGS, 'energy', 'light')).toBeNull();
    });

    it('drops an oversized SVG → null', async () => {
        const app = makeApp({ '999_Brand/icons/big.svg': { content: goodSvg, size: 300 * 1024 } });
        expect(await getBrandIcon(app, SETTINGS, 'big', 'light')).toBeNull();
    });

    it('cache key includes the full folder path — same name in different folders does NOT collide (audit H1)', async () => {
        const settingsA = { brandFolderPath: 'BrandA' } as unknown as AIOrganiserSettings;
        const settingsB = { brandFolderPath: 'BrandB' } as unknown as AIOrganiserSettings;
        // Distinct path geometry (the `d` attr survives sanitize) marks each folder.
        const svgA = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M11 11"/></svg>';
        const svgB = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M22 22"/></svg>';
        // Same concept ("logo"), same mtime, but different folders → distinct keys.
        const appA = makeApp({ 'BrandA/icons/logo.svg': { content: svgA, mtime: 5 } });
        const appB = makeApp({ 'BrandB/icons/logo.svg': { content: svgB, mtime: 5 } });
        const a = decodeRaster((await getBrandIcon(appA, settingsA, 'logo', 'light'))!);
        const b = decodeRaster((await getBrandIcon(appB, settingsB, 'logo', 'light'))!);
        expect(a).toContain('M11 11');
        expect(b).toContain('M22 22');  // NOT the cached A markup
    });

    it('cache key includes the recolour colour — light + dark of one file do not collide (audit M5)', async () => {
        const inkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M1 1"/></svg>';
        const app = makeApp({ '999_Brand/icons/leaf.svg': { content: inkSvg, mtime: 7 } });
        // Resolve dark first (caches under the ink recolour key)...
        const dark = decodeRaster((await getBrandIcon(app, SETTINGS, 'leaf', 'dark'))!);
        // ...then light: same path + mtime, but the recolour colour differs, so the
        // dark raster must NOT be served for the light variant.
        const light = decodeRaster((await getBrandIcon(app, SETTINGS, 'leaf', 'light'))!);
        expect(dark).toContain('#1A1A2E');
        expect(light).toContain('#FFFFFF');
        expect(light).not.toContain('#1A1A2E');
    });

    it('cache key includes mtime — a re-read after mtime change re-resolves', async () => {
        const app1 = makeApp({ '999_Brand/icons/c.svg': { content: goodSvg, mtime: 10 } });
        const first = await getBrandIcon(app1, SETTINGS, 'c', 'light');
        expect(first).toMatch(/^data:image\/png;base64,/);
        // Same mtime → cached (even if the new app would return empty content).
        const appEmpty = makeApp({ '999_Brand/icons/c.svg': { content: '', mtime: 10 } });
        const cached = await getBrandIcon(appEmpty, SETTINGS, 'c', 'light');
        expect(cached).toBe(first);
        // Changed mtime → bypasses cache → empty content sanitizes to null.
        const appChanged = makeApp({ '999_Brand/icons/c.svg': { content: '', mtime: 20 } });
        expect(await getBrandIcon(appChanged, SETTINGS, 'c', 'light')).toBeNull();
    });
});
