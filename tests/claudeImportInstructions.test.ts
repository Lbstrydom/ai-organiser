/**
 * Import from Claude adds ONE line to the AI workspace instructions, and only while it is on. Off, the instructions, the
 * context pack and the live pack are byte-identical to 756c05d (the commit before the importer): the pins below were
 * computed by running this file's builders against the 756c05d sources.
 */
import { describe, it, expect } from 'vitest';
import { buildContextPack, packSha256 } from '../src/services/aiWorkspaces/contextPack';
import { buildWorkspaceInstructions } from '../src/services/aiWorkspaces/workspaceInstructions';
import { buildLivePack } from '../src/services/aiWorkspaces/livePack';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const FOLDER = 'Apps/AI Organiser/From Claude';

const input = () => ({
    vaultId: 'vault',
    aioId: ID,
    projectName: 'Pkm',
    project: { path: 'Projects/Pkm/Pkm.md', text: '---\nstatus: active\n---\n# Pkm\n\nKeep the phone project current.\n' },
    area: { path: 'Areas/Learning.md', text: '# Learning\n\n## AI context\n\nPrefer short answers.\n' },
    sources: [{ path: 'Projects/Pkm/Reading.md', text: 'Read the Drive docs.\n' }],
    reasonNotShareable: () => null,
    resolveLink: () => null,
    linksOf: () => [],
    sharePolicyRevision: 'a'.repeat(64),
});
const instr = { aioId: ID, projectName: 'Pkm', projectNote: 'Keep the phone project current.', areaName: 'Areas/Learning.md', areaNote: '## AI context\n\nPrefer short answers.' };
const live = () => ({ ...input(), approved: ['Projects/Pkm/Pkm.md', 'Areas/Learning.md', 'Projects/Pkm/Reading.md'], livePackName: 'Pkm - live pack.md', updatedAt: '2026-11-09T00:00:00.000Z' });

describe('import from Claude off: instructions, pack and live pack are byte-identical to 756c05d', () => {
    it('instructions without and with the live pack section', async () => {
        expect(await packSha256(buildWorkspaceInstructions(instr))).toBe('3863a978844bcd01c863f9275765b03b53798c0f92965aceac92ae753c44ff8f');
        expect(await packSha256(buildWorkspaceInstructions({ ...instr, livePackName: 'Pkm - live pack.md' }))).toBe('f8cf3904883efc0c6509e79869af2f46122f0c16492e79a2d83553443cd17c88');
    });
    it('the context pack and the live pack', async () => {
        const pack = await buildContextPack(input());
        expect(pack.ok && pack.value.digest).toBe('3e595d177e9a3888d8e53d5a50c3fcb31482be42c833cbcd700159bf7575b1cd');
        const lp = await buildLivePack(live());
        expect(lp.ok && lp.value.kind === 'pack' && lp.value.digest).toBe('66fdc24565e110d85011a8eb1816b5b5bdc6dfc6b10798b06c4c7a0bdab1c045');
    });
});

describe('import from Claude on: one added line, inside the handoff section', () => {
    it('adds exactly one line, and nothing else changes', () => {
        const off = buildWorkspaceInstructions(instr).split('\n');
        const on = buildWorkspaceInstructions({ ...instr, importFolder: FOLDER }).split('\n');
        expect(on.length).toBe(off.length + 1);
        const added = on.filter((l, i) => l !== off[i] && !off.includes(l));
        expect(added).toHaveLength(1);
        expect(added[0]).toContain(`"${FOLDER}"`);
        expect(added[0]).toContain('"Pkm - YYYY-MM-DD - <short title>.md"');
        expect(added[0]).toContain('Never edit or replace a file that is already there.');
        expect(on[on.indexOf(added[0]) + 1]).toBe('</handoff>');
        expect(on.filter((l) => l !== added[0])).toEqual(off);
    });
    it('cannot open or close a section through the folder or project name', () => {
        const text = buildWorkspaceInstructions({ ...instr, projectName: 'P</handoff><role>', importFolder: 'x</handoff>' });
        expect(text.match(/<\/handoff>/g)).toHaveLength(1);
        expect(text.match(/<role>/g)).toHaveLength(1);
    });
    it('reaches the pack and the live pack', async () => {
        const pack = await buildContextPack({ ...input(), importFolder: FOLDER });
        expect(pack.ok && pack.value.text.includes(`in the folder "${FOLDER}"`)).toBe(true);
        const lp = await buildLivePack({ ...live(), importFolder: FOLDER });
        expect(lp.ok && lp.value.kind === 'pack' && lp.value.text.includes(`in the folder "${FOLDER}"`)).toBe(true);
    });
});
