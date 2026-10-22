/**
 * The optional write of the instructions block into `AGENTS.md` (default off).
 *
 * Preview first, then write: the user sees the block as it will be (and a before/after when one
 * exists) and presses Apply; the write uses `applyNoteEdit` (`composite`, `review: false` because the
 * preview is the gate). Only the owned block changes; text outside the markers is never touched, a
 * damaged marker set is a conflict that writes nothing, and a repeat run is a byte-identical no-op.
 * Consent covers the note the user saw: if the block appeared or vanished since the preview, nothing
 * is written (`baseline-changed`).
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable, normalisePath, type ProtectedSource } from '../../core/protectedPaths';
import { findMarkedBlock, replaceMarkedBlock, type BlockMarkers } from '../../utils/ownedBlock';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { logger } from '../../utils/logger';
import { AGENT_BLOCK_END, AGENT_BLOCK_START, renderInstructionsBlock } from './agentInstructions';

export const AGENT_MARKERS: BlockMarkers = { start: AGENT_BLOCK_START, end: AGENT_BLOCK_END, nestedPrefixes: ['<!-- aio:agent-instructions', '<!-- /aio:agent-instructions'] };

/** Vault-relative Markdown path, outside `.obsidian` and any protected folder. Returns the normalised path. */
export function validateInstructionsPath(raw: string, protectedFolders: ProtectedSource): Result<string> {
    const trimmed = raw.trim();
    if (trimmed === '' || /^([a-zA-Z]:|[\\/])/.test(trimmed) || trimmed.split(/[\\/]/).includes('..')) return err('instructions-path-invalid');
    const path = normalisePath(trimmed);
    if (path === '' || !path.toLowerCase().endsWith('.md')) return err('instructions-path-invalid');
    if (path.split('/').some((segment) => segment.startsWith('.'))) return err('instructions-path-invalid');
    if (!assertWritable(protectedFolders, 'modify', path).ok) return err('protected-path');
    return ok(path);
}

export interface InstructionsPreview {
    path: string;
    /** The note does not exist yet */
    creates: boolean;
    /** The block as it is in the note now, or null when there is none */
    before: string | null;
    /** The block as it will be */
    after: string;
    /** The whole note as it will be */
    next: string;
    changed: boolean;
}

/** Decide what the note should contain, without writing. Pure given the current text. */
export function planInstructions(current: string | null, block: string): Result<{ next: string; before: string | null; changed: boolean }> {
    const base = current ?? '';
    const found = findMarkedBlock(base, AGENT_MARKERS);
    if (!found.ok) return err(found.error);
    const next = replaceMarkedBlock(base, block, AGENT_MARKERS);
    if (!next.ok) return err(next.error);
    return ok({ next: next.value, before: found.value ? found.value.text : null, changed: current === null || next.value !== current });
}

export async function previewInstructions(plugin: AIOrganiserPlugin): Promise<Result<InstructionsPreview>> {
    const s = plugin.settings;
    const path = validateInstructionsPath(s.agentInstructionsPath, s.protectedFolders);
    if (!path.ok) return err(path.error);
    const file = plugin.app.vault.getAbstractFileByPath(path.value);
    if (file && !(file instanceof TFile)) return err('instructions-path-invalid');
    let current: string | null = null;
    try {
        current = file instanceof TFile ? await plugin.app.vault.read(file) : null;
    } catch (e) {
        logger.error('AgentIndex', 'Could not read the instructions file', e);
        return err('write-failed');
    }
    const block = renderInstructionsBlock(s);
    const plan = planInstructions(current, block);
    if (!plan.ok) return err(plan.error === 'marker-conflict' ? 'instructions-conflict' : plan.error);
    return ok({ path: path.value, creates: current === null, before: plan.value.before, after: block, next: plan.value.next, changed: plan.value.changed });
}

export type InstructionsWrite = 'created' | 'updated' | 'unchanged';

/** Write what the preview showed. Never throws. */
export async function applyInstructions(plugin: AIOrganiserPlugin, preview: InstructionsPreview): Promise<Result<InstructionsWrite>> {
    const s = plugin.settings;
    // Settings may have changed while the preview was open.
    const path = validateInstructionsPath(s.agentInstructionsPath, s.protectedFolders);
    if (!path.ok || path.value !== preview.path) return err(path.ok ? 'baseline-changed' : path.error);
    if (!preview.changed) return ok('unchanged');
    const vault = plugin.app.vault;
    try {
        const file = vault.getAbstractFileByPath(preview.path);
        if (!file) {
            if (!preview.creates) return err('baseline-changed');
            if (!assertWritable(s.protectedFolders, 'create', preview.path).ok) return err('protected-path');
            const slash = preview.path.lastIndexOf('/');
            if (slash > 0 && !vault.getAbstractFileByPath(preview.path.slice(0, slash))) await vault.createFolder(preview.path.slice(0, slash));
            await vault.create(preview.path, `${preview.after}\n`);
            return ok('created');
        }
        if (!(file instanceof TFile) || preview.creates) return err('baseline-changed');
        const baseline = await vault.read(file);
        const hadBlock = preview.before !== null;
        const res = await applyNoteEdit(plugin, {
            kind: 'composite',
            filePath: preview.path,
            baseline,
            recompute: (latest) => {
                const found = findMarkedBlock(latest, AGENT_MARKERS);
                if (!found.ok) return err('instructions-conflict');
                // The user agreed to what they saw: a block that appeared, vanished or was edited since is a new case.
                if ((found.value !== null) !== hadBlock) return err('baseline-changed');
                if (found.value !== null && found.value.text !== preview.before) return err('baseline-changed');
                const next = replaceMarkedBlock(latest, preview.after, AGENT_MARKERS);
                return next.ok ? ok({ content: next.value }) : err('instructions-conflict');
            },
        }, { review: false });
        return res.ok ? ok('updated') : err(res.error);
    } catch (e) {
        logger.error('AgentIndex', 'Could not write the agent instructions', e);
        return err('write-failed');
    }
}
