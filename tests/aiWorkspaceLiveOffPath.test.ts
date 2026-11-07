/**
 * The live pack ships default-off and byte-identical when off: these pins were recorded at 2b29b6b, before the live pack existed.
 * A change to any of them means the off path changed, which the feature promises it never does.
 */
import { describe, it, expect } from 'vitest';
import { buildContextPack } from '../src/services/aiWorkspaces/contextPack';
import { buildWorkspaceInstructions } from '../src/services/aiWorkspaces/workspaceInstructions';
import { normaliseWorkspace } from '../src/services/aiWorkspaces/workspaceRecord';
import { packSha256 } from '../src/services/aiWorkspaces/contextPack';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';

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

describe('live pack off path is byte-identical to 2b29b6b', () => {
    it('the context pack digest is unchanged', async () => {
        const res = await buildContextPack(input());
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.digest).toBe('3e595d177e9a3888d8e53d5a50c3fcb31482be42c833cbcd700159bf7575b1cd');
    });

    it('the instructions are unchanged', async () => {
        const text = buildWorkspaceInstructions({ aioId: ID, projectName: 'Pkm', projectNote: 'Keep the phone project current.', areaName: 'Areas/Learning.md', areaNote: '## AI context\n\nPrefer short answers.' });
        expect(await packSha256(text)).toBe('3863a978844bcd01c863f9275765b03b53798c0f92965aceac92ae753c44ff8f');
    });

    it('a record without a live pack normalises with no live key', () => {
        const raw = { version: 1, anchorId: ID, chats: [], contextSources: ['Projects/Pkm/Reading.md'], packs: [], released: false };
        const rec = normaliseWorkspace(raw);
        expect(rec).toEqual(raw);
        expect(rec && 'live' in rec).toBe(false);
    });
});
