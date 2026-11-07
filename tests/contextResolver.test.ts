import { describe, it, expect } from 'vitest';
import { resolveRoles, rankForContext, candidatesFor, CONTEXT_ROLES } from '../src/core/contextResolver';
import { ACTIONS, ACTION_BY_ID } from '../src/core/actionRegistry';
import { acceptsTarget, ACTION_TARGET_HANDLERS } from '../src/services/actionRunner';

const settings = { sweepInboxFolders: ['0 Inbox'], sweepReportPath: 'Inbox sweep report.md' };
const md = (path: string, frontmatter?: Record<string, unknown>, hasSelection = false) =>
    ({ kind: 'file' as const, path, extension: 'md', frontmatter, hasSelection });

describe('resolveRoles — deterministic, from path, extension and plugin-written frontmatter', () => {
    it('file kinds', () => {
        expect(resolveRoles({ kind: 'file', path: 'a/Team sync.m4a', extension: 'm4a' }, settings)).toEqual(['audio']);
        expect(resolveRoles({ kind: 'file', path: 'a/x.PDF', extension: 'PDF' }, settings)).toEqual(['pdf']);
        expect(resolveRoles({ kind: 'file', path: 'a/x.png', extension: 'png' }, settings)).toEqual(['image']);
        expect(resolveRoles({ kind: 'file', path: 'a/x.canvas', extension: 'canvas' }, settings)).toEqual(['canvas']);
        expect(resolveRoles(md('a/x.md'), settings)).toEqual(['markdown']);
    });
    it('a project note (aio-role: project)', () => {
        expect(resolveRoles(md('1 Projects/P.md', { 'aio-role': 'project' }), settings)).toEqual(['project', 'markdown']);
        expect(resolveRoles(md('1 Projects/P.md', { 'aio-role': 'area' }), settings)).toEqual(['markdown']);
    });
    it('minutes need both plugin keys, never one alone', () => {
        expect(resolveRoles(md('m.md', { type: 'meeting', meeting_title: 'Sync' }), settings)).toEqual(['minutes', 'markdown']);
        expect(resolveRoles(md('m.md', { type: 'meeting' }), settings)).toEqual(['markdown']);
        expect(resolveRoles(md('Meeting minutes 2026.md'), settings)).toEqual(['markdown']);
    });
    it('inbox and the sweep report come from the settings, not the name', () => {
        expect(resolveRoles(md('0 Inbox/idea.md'), settings)).toEqual(['inbox', 'markdown']);
        expect(resolveRoles(md('0 Inboxes/idea.md'), settings)).toEqual(['markdown']);
        expect(resolveRoles(md('Inbox sweep report.md'), settings)).toEqual(['sweep-report', 'markdown']);
        expect(resolveRoles(md('inbox notes.md'), settings)).toEqual(['markdown']);
    });
    it('selection, folder and multi', () => {
        expect(resolveRoles(md('a.md', undefined, true), settings)).toEqual(['selection', 'markdown']);
        expect(resolveRoles({ kind: 'folder', path: 'x' }, settings)).toEqual(['folder']);
        expect(resolveRoles({ kind: 'files', count: 3 }, settings)).toEqual(['multi']);
        expect(resolveRoles({ kind: 'files', count: 1 }, settings)).toEqual([]);
    });
    it('roles come out in the declared specificity order', () => {
        const roles = resolveRoles(md('0 Inbox/p.md', { 'aio-role': 'project' }, true), settings);
        expect(roles).toEqual(CONTEXT_ROLES.filter((r) => roles.includes(r)));
    });
});

describe('rankForContext and candidatesFor', () => {
    it('ranks the audio actions for an audio file', () => {
        const ranked = rankForContext(['audio']).map((r) => r.def.id);
        expect(ranked).toEqual(expect.arrayContaining(['transcribe-audio', 'create-meeting-minutes', 'play-narration']));
    });
    it('for a right-clicked .m4a, Transcribe audio is the action that accepts the file', () => {
        const ready = { state: 'ready' as const, reasons: [] };
        const out = candidatesFor(['audio'], (d) => (d.requires === 'mp3-file' ? { state: 'wrong-target' as const, reasons: ['wrong-target' as const] } : ready), (d) => acceptsTarget(d.id, 'file'));
        expect(out.map((d) => d.id)).toEqual(['transcribe-audio']);
    });
    it('is stable: the same roles always give the same list', () => {
        const a = rankForContext(['project', 'markdown']).map((r) => r.def.id);
        const b = rankForContext(['project', 'markdown']).map((r) => r.def.id);
        expect(a).toEqual(b);
    });
    it('a more specific role outranks a general one', () => {
        const ranked = rankForContext(['project', 'markdown']).map((r) => r.def.id);
        const firstProject = ranked.findIndex((id) => ACTION_BY_ID.get(id)!.contexts?.includes('project'));
        const firstMarkdownOnly = ranked.findIndex((id) => !ACTION_BY_ID.get(id)!.contexts?.includes('project'));
        expect(firstProject).toBeLessThan(firstMarkdownOnly);
    });
    it('candidatesFor keeps only ready actions that accept the target, capped', () => {
        const ready = { state: 'ready' as const, reasons: [] };
        const off = { state: 'feature-off' as const, reasons: ['feature-off' as const] };
        const out = candidatesFor(['markdown'], (d) => (d.id === 'enhance-note' ? off : ready), () => true, 3);
        expect(out.length).toBeLessThanOrEqual(3);
        expect(out.map((d) => d.id)).not.toContain('enhance-note');
        expect(candidatesFor(['markdown'], () => ready, () => false)).toEqual([]);
    });
    it('every context tag on an action is a known role', () => {
        for (const def of ACTIONS) for (const r of def.contexts ?? []) expect(CONTEXT_ROLES as readonly string[]).toContain(r);
    });
});

describe('target bindings', () => {
    it('every binding names a registered action', () => {
        for (const id of Object.keys(ACTION_TARGET_HANDLERS)) expect(ACTION_BY_ID.has(id), id).toBe(true);
    });
    it('only bound actions accept a file or a multi-selection; every action accepts the active context', () => {
        expect(acceptsTarget('transcribe-audio', 'file')).toBe(true);
        expect(acceptsTarget('enhance-note', 'file')).toBe(false);
        expect(acceptsTarget('smart-tag', 'files')).toBe(true);
        expect(acceptsTarget('sweep-inbox', 'active')).toBe(true);
        expect(acceptsTarget('sweep-inbox', 'selection')).toBe(false);
    });
});
