import { describe, it, expect } from 'vitest';
import { admit, driveDisplayPath, isTextCandidate, needsRead, observe, readOrder, stability, targetNames, BACKGROUND_REHASH_MS } from '../src/services/claudeImport/importPolicy';
import { decodeLedger, emptyLedger } from '../src/services/claudeImport/importLedger';
import { checkDestination, claudeImportActive, importFolderForInstructions } from '../src/services/claudeImport/importGate';
import { classifyHandoff } from '../src/services/claudeImport/handoffRoute';
import type { ProjectRef } from '../src/services/projects/projectIndex';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const SHA = 'a'.repeat(64);

describe('claude import: names', () => {
    it('looks only at .md and .txt files that are not hidden or lock files', () => {
        expect(isTextCandidate('From Claude test - 2026-11-09.md')).toBe(true);
        expect(isTextCandidate('notes.TXT')).toBe(true);
        expect(isTextCandidate('report.docx')).toBe(false);
        expect(isTextCandidate('.hidden.md')).toBe(false);
        expect(isTextCandidate('~$draft.md')).toBe(false);
        expect(isTextCandidate('md')).toBe(false);
    });
    it('names the copy after the source, with .md, then with 8 hex digits of the hash', () => {
        expect(targetNames('From Claude phone test.md', SHA)).toEqual(['From Claude phone test.md', 'From Claude phone test-aaaaaaaa.md']);
        expect(targetNames('summary.txt', SHA)).toEqual(['summary.md', 'summary-aaaaaaaa.md']);
        expect(targetNames('Draft.MD', SHA)[0]).toBe('Draft.md');
    });
    it('derives the folder Claude sees in Drive', () => {
        expect(driveDisplayPath('G:\\My Drive\\Apps\\AI Organiser\\From Claude')).toBe('Apps/AI Organiser/From Claude');
        expect(driveDisplayPath('/Users/l/Google Drive/My Drive/Apps/From Claude/')).toBe('Apps/From Claude');
        // Nothing is guessed outside My Drive, or for My Drive itself.
        expect(driveDisplayPath('D:\\Sync\\From Claude')).toBe('');
        expect(driveDisplayPath('G:\\My Drive')).toBe('');
        expect(driveDisplayPath('')).toBe('');
    });
});

describe('claude import: stability and the fair order', () => {
    const cur = { fid: '1:2', size: 10, mtimeMs: 1000 };
    it('keeps the first-seen time of an unchanged file and starts again when it changes', () => {
        const a = observe(undefined, cur, 5000);
        expect(a.at).toBe(5000);
        expect(observe({ ...a, hash: SHA }, cur, 9000)).toEqual({ ...a, hash: SHA });
        const changed = observe({ ...a, hash: SHA, attemptedAt: 7000 }, { ...cur, size: 11 }, 9000);
        expect(changed).toEqual({ fid: '1:2', size: 11, mtimeMs: 1000, at: 9000, attemptedAt: 7000 });
    });
    it('trusts an old modified time only on a run the person started; an empty file always waits', () => {
        const fresh = observe(undefined, cur, 100_000);
        expect(stability(fresh, 100_000, 30_000, false).ready).toBe(false);
        expect(stability(fresh, 100_000, 30_000, true).ready).toBe(true);
        expect(stability(fresh, 130_000, 30_000, false).ready).toBe(true);
        expect(stability(observe(undefined, { ...cur, size: 0 }, 0), 1e9, 30_000, true).ready).toBe(false);
    });
    it('reads a cached file again on every manual run and at most daily in the background', () => {
        const e = { ...observe(undefined, cur, 0), hash: SHA, hashedAt: 1000 };
        expect(needsRead(e, 2000, true)).toBe(true);
        expect(needsRead(e, 2000, false)).toBe(false);
        expect(needsRead(e, 1000 + BACKGROUND_REHASH_MS, false)).toBe(true);
        expect(needsRead({ ...e, hash: undefined }, 2000, false)).toBe(true);
    });
    it('puts never-attempted files first, then the least recently attempted, mtime only breaking ties', () => {
        const item = (name: string, attemptedAt: number | undefined, mtimeMs: number) => ({ name, entry: { fid: name, size: 1, mtimeMs, at: 0, ...(attemptedAt !== undefined ? { attemptedAt } : {}) } });
        const order = readOrder([item('old-tried', 5, 1), item('new', undefined, 999), item('tried-earlier', 2, 500), item('also-new', undefined, 3)], 3).map((i) => i.name);
        expect(order).toEqual(['also-new', 'new', 'tried-earlier']);
    });
});

describe('claude import: admission (copied byte for byte, or refused)', () => {
    it('accepts plain notes, a BOM, CRLF, ordinary code blocks and harmless properties', () => {
        expect(admit(enc('# Summary\n\nSome text.')).ok).toBe(true);
        expect(admit(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('---\ntitle: x\n---\nBody')])).ok).toBe(true);
        expect(admit(enc('Line one\r\nLine two\r\n')).ok).toBe(true);
        expect(admit(enc('```python\nprint(1)\n```\n```mermaid\ngraph TD\n```')).ok).toBe(true);
        expect(admit(enc('---\n---\nEmpty properties')).ok).toBe(true);
        expect(admit(enc('---\nan opening line only')).ok).toBe(true);
    });
    it('refuses text that is not UTF-8 or contains NUL', () => {
        expect(admit(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({ ok: false, reason: 'not-text' });
        expect(admit(enc('a\u0000b'))).toEqual({ ok: false, reason: 'not-text' });
    });
    it('refuses properties it cannot read, and the plugin\'s own properties in any case', () => {
        expect(admit(enc('---\n- a\n- b\n---\nx'))).toEqual({ ok: false, reason: 'frontmatter-unreadable' });
        expect(admit(enc('---\nkey: [unclosed\n---\nx'))).toEqual({ ok: false, reason: 'frontmatter-unreadable' });
        for (const key of ['aio-id', 'AIO-Role', '"aio-status"', 'capture-id', 'aio_live']) {
            expect(admit(enc(`---\n${key}: x\n---\nbody`))).toEqual({ ok: false, reason: 'reserved-property' });
        }
    });
    it('refuses the plugin\'s markers anywhere', () => {
        expect(admit(enc('text\n<!-- aio:capture -->\n'))).toEqual({ ok: false, reason: 'reserved-marker' });
        expect(admit(enc('- x <!-- aio:handoff id=1 -->'))).toEqual({ ok: false, reason: 'reserved-marker' });
        expect(admit(enc('<!--/aio:workspace-->'))).toEqual({ ok: false, reason: 'reserved-marker' });
    });
    it('refuses code blocks and inline forms that known plugins run', () => {
        for (const t of ['> ```dataviewjs\n> dv.paragraph(1)\n> ```', '- item\n\n    ```dataviewjs\n    x\n    ```', '```dataviewjs\ndv.paragraph(1)\n```', '~~~ js-engine\nx\n~~~', '```{button}\nname x\n```', 'inline `$= dv.current()`', 'Templater <% tp.date.now() %>']) {
            expect(admit(enc(t))).toEqual({ ok: false, reason: 'active-content' });
        }
    });
});

describe('claude import: ledger codec (fails closed)', () => {
    it('reads absent as empty and refuses anything misshapen', () => {
        expect(decodeLedger(undefined)).toEqual({ status: 'ok', ledger: emptyLedger() });
        const good = { ...emptyLedger(), imported: { [SHA]: { name: 'a.md', path: 'In/a.md', at: 'x', verified: true } } };
        expect(decodeLedger(JSON.parse(JSON.stringify(good)))).toEqual({ status: 'ok', ledger: good });
        expect(decodeLedger([]).status).toBe('corrupt');
        expect(decodeLedger(null).status).toBe('corrupt');
        // A file time before 1970 is negative, and valid.
        const old = { ...emptyLedger(), seen: { 'a.md': { fid: '1:2', size: 1, mtimeMs: -1000, at: 5 } } };
        expect(decodeLedger(old)).toEqual({ status: 'ok', ledger: old });
        expect(decodeLedger({ v: 2 }).status).toBe('corrupt');
        expect(decodeLedger({ ...emptyLedger(), imported: { nothex: good.imported[SHA] } }).status).toBe('corrupt');
        expect(decodeLedger({ ...emptyLedger(), refused: { 'a.md': { fid: '1', size: 1, mtimeMs: 1, reason: 'odd', maxKB: 1 } } }).status).toBe('corrupt');
    });
});

describe('claude import: gate and destination', () => {
    const on = { featureFlags: { 'claude-import': true }, claudeImportSourceFolder: 'G:\\My Drive\\Apps\\AI Organiser\\From Claude' } as never;
    it('is active only while on with a folder, and only then names a folder for the instructions', () => {
        expect(claudeImportActive(on)).toBe(true);
        expect(importFolderForInstructions(on)).toBe('Apps/AI Organiser/From Claude');
        expect(importFolderForInstructions({ featureFlags: {}, claudeImportSourceFolder: 'G:\\My Drive\\x' } as never)).toBeUndefined();
        expect(importFolderForInstructions({ featureFlags: { 'claude-import': true }, claudeImportSourceFolder: 'D:\\Sync\\From Claude' } as never)).toBeUndefined();
        // A path that cannot be quoted exactly is not named at all (never reshaped).
        expect(importFolderForInstructions({ featureFlags: { 'claude-import': true }, claudeImportSourceFolder: 'G:\\My Drive\\Apps\\"AI"' } as never)).toBeUndefined();
        expect(importFolderForInstructions({ featureFlags: { 'claude-import': true }, claudeImportSourceFolder: ' ' } as never)).toBeUndefined();
    });
    it('accepts a plain vault folder and refuses climbs, the config folder and protected folders', () => {
        const none = (): boolean => false;
        expect(checkDestination(' 0 Inbox/From Claude/ ', none)).toEqual({ ok: true, value: '0 Inbox/From Claude' });
        expect(checkDestination('0 Inbox\\From Claude', none)).toEqual({ ok: true, value: '0 Inbox/From Claude' });
        expect(checkDestination('../outside', none).ok).toBe(false);
        expect(checkDestination('.obsidian/x', none).ok).toBe(false);
        expect(checkDestination('config/x', none, 'config').ok).toBe(false);
        expect(checkDestination('Config Notes/x', none, 'config').ok).toBe(true);
        expect(checkDestination('', none).ok).toBe(false);
        expect(checkDestination('Private/x', (p) => p.startsWith('Private'))).toEqual({ ok: false, error: 'claude-import-destination-protected' });
    });
});

describe('claude import: hand-back routing fails closed', () => {
    const P1 = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
    const DUP = '7a1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
    const ZZZ = '8b1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
    const project = (aioId: string, notePath: string): ProjectRef => ({ aioId, notePath, folder: '', rootKind: null, status: '', pairing: 'none' as never });
    const handoff = (id?: string): string => `# Session\n\n## Handoff\n${id ? `Project ID: ${id}\n` : ''}Chat project: PKM (claude)\n\n### Deliverables\n- notes.md: summary (draft)\n`;
    const ctx = (over: Partial<Parameters<typeof classifyHandoff>[1]> = {}) => ({
        reviewActive: true,
        index: { projects: [project(P1, '1 Projects/PKM.md'), project(DUP, 'A.md'), project(DUP, 'B.md')], duplicates: new Map([[DUP, ['A.md', 'B.md']]]) },
        isProtected: () => false,
        contexts: [],
        ...over,
    });
    it('routes an id that names exactly one project', () => {
        expect(classifyHandoff(handoff(P1), ctx())).toEqual({ kind: 'routed', projectId: P1, notePath: '1 Projects/PKM.md' });
    });
    it('does not route a plain note, a missing, unknown or duplicated id, a protected target or a review that is off', () => {
        expect(classifyHandoff('# Just notes', ctx()).kind).toBe('not-handback');
        expect(classifyHandoff(handoff(), ctx()).kind).toBe('no-id');
        expect(classifyHandoff(handoff(ZZZ), ctx()).kind).toBe('unknown-project');
        expect(classifyHandoff(handoff(DUP), ctx()).kind).toBe('unknown-project');
        expect(classifyHandoff(handoff(P1), ctx({ isProtected: () => true })).kind).toBe('protected');
        expect(classifyHandoff(handoff(P1), ctx({ reviewActive: false })).kind).toBe('review-off');
        expect(classifyHandoff(handoff(P1), ctx({ index: null })).kind).toBe('unknown-project');
    });
});
