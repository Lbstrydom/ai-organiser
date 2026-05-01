/**
 * Pure unit tests for pickerRequirements.checkRequirement + buildContext.
 * No Obsidian harness — plain object stubs only (audit R1 M5 + R2 H2).
 */

import { describe, it, expect } from 'vitest';
import {
    checkRequirement,
    buildContext,
    legacyHomeAliases,
    type RequirementContext,
} from '../src/ui/modals/pickerRequirements';
import { en } from '../src/i18n/en';

const t = en;
const baseCtx: RequirementContext = {
    hasActiveMdNote: false,
    hasEditorSelection: false,
    hasMarkdownFiles: false,
    semanticSearchEnabled: false,
    semanticSearchIndexed: false,
};

describe('checkRequirement — none / undefined', () => {
    it('returns met:true for "none"', () => {
        expect(checkRequirement('none', baseCtx, t).met).toBe(true);
    });
    it('returns met:true for undefined', () => {
        expect(checkRequirement(undefined, baseCtx, t).met).toBe(true);
    });
});

describe('checkRequirement — active-note', () => {
    it('returns met:false when no md note active', () => {
        const r = checkRequirement('active-note', baseCtx, t);
        expect(r.met).toBe(false);
        expect(r.chipIcon).toBe('file-edit');
        expect(r.chipText).toBe(t.modals.commandPicker.requiresChipNote);
        expect(r.reason).toBe(t.modals.commandPicker.requiresReasonNote);
    });
    it('returns met:true when md note active', () => {
        expect(checkRequirement('active-note', { ...baseCtx, hasActiveMdNote: true }, t).met).toBe(true);
    });
});

describe('checkRequirement — selection', () => {
    it('returns met:false when nothing selected', () => {
        const r = checkRequirement('selection', baseCtx, t);
        expect(r.met).toBe(false);
        expect(r.chipIcon).toBe('type');
        expect(r.chipText).toBe(t.modals.commandPicker.requiresChipSelection);
    });
    it('returns met:true when selection present', () => {
        expect(checkRequirement('selection', { ...baseCtx, hasEditorSelection: true }, t).met).toBe(true);
    });
});

describe('checkRequirement — vault', () => {
    it('returns met:false when no md files in vault', () => {
        const r = checkRequirement('vault', baseCtx, t);
        expect(r.met).toBe(false);
        expect(r.chipIcon).toBe('library');
    });
    it('returns met:true when ≥1 md file', () => {
        expect(checkRequirement('vault', { ...baseCtx, hasMarkdownFiles: true }, t).met).toBe(true);
    });
});

describe('checkRequirement — semantic-search (R2 M3 split reasons)', () => {
    it('returns "disabled" reason when setting off', () => {
        const r = checkRequirement('semantic-search', baseCtx, t);
        expect(r.met).toBe(false);
        expect(r.reason).toBe(t.modals.commandPicker.requiresReasonSemanticSearchDisabled);
    });
    it('returns "unindexed" reason when setting on but index missing', () => {
        const r = checkRequirement('semantic-search', { ...baseCtx, semanticSearchEnabled: true }, t);
        expect(r.met).toBe(false);
        expect(r.reason).toBe(t.modals.commandPicker.requiresReasonSemanticSearchUnindexed);
    });
    it('returns met:true when enabled AND indexed', () => {
        const r = checkRequirement('semantic-search', {
            ...baseCtx, semanticSearchEnabled: true, semanticSearchIndexed: true,
        }, t);
        expect(r.met).toBe(true);
    });
});

describe('buildContext — mapping from raw plugin/app state', () => {
    it('marks active md note correctly', () => {
        const ctx = buildContext({
            activeFile: { extension: 'md' },
            editor: null,
            hasMarkdownFiles: true,
            enableSemanticSearch: true,
            hasVectorStore: true,
        });
        expect(ctx.hasActiveMdNote).toBe(true);
        expect(ctx.semanticSearchEnabled).toBe(true);
        expect(ctx.semanticSearchIndexed).toBe(true);
    });
    it('rejects non-md active file', () => {
        const ctx = buildContext({
            activeFile: { extension: 'pdf' },
            editor: null,
            hasMarkdownFiles: false,
            enableSemanticSearch: false,
            hasVectorStore: false,
        });
        expect(ctx.hasActiveMdNote).toBe(false);
    });
    it('keeps semantic-search prerequisites separate (R2 M3)', () => {
        // Setting on, store off
        const a = buildContext({ activeFile: null, editor: null, hasMarkdownFiles: false,
            enableSemanticSearch: true, hasVectorStore: false });
        expect(a.semanticSearchEnabled).toBe(true);
        expect(a.semanticSearchIndexed).toBe(false);
        // Setting off, store on
        const b = buildContext({ activeFile: null, editor: null, hasMarkdownFiles: false,
            enableSemanticSearch: false, hasVectorStore: true });
        expect(b.semanticSearchEnabled).toBe(false);
        expect(b.semanticSearchIndexed).toBe(true);
    });
    it('selection check delegates to editor.somethingSelected()', () => {
        const editor = { somethingSelected: () => true };
        const ctx = buildContext({
            activeFile: null, editor, hasMarkdownFiles: false,
            enableSemanticSearch: false, hasVectorStore: false,
        });
        expect(ctx.hasEditorSelection).toBe(true);
    });
});

describe('legacyHomeAliases — backward-compat search vocabulary derivation', () => {
    it('returns active-note + export for active-note-export', () => {
        expect(legacyHomeAliases('active-note-export')).toEqual(['active note', 'export']);
    });
    it('returns capture for capture', () => {
        expect(legacyHomeAliases('capture')).toEqual(['capture']);
    });
    it('returns vault + visualize + visualise for vault-visualize', () => {
        expect(legacyHomeAliases('vault-visualize')).toEqual(['vault', 'visualize', 'visualise']);
    });
    it('returns empty array for unknown legacy home', () => {
        expect(legacyHomeAliases('made-up-home')).toEqual([]);
    });
});
