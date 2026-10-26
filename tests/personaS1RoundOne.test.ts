import { describe, it, expect } from 'vitest';
import { stripWorkspaceBlock } from '../src/services/aiWorkspaces/workspaceBlock';
import { buildWorkspaceInstructions } from '../src/services/aiWorkspaces/workspaceInstructions';

const base = { aioId: '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b', projectName: 'Plan X' };

describe('stripWorkspaceBlock only normalises the join and the end', () => {
    it('leaves blank-line runs inside the note (code included) as written', () => {
        const text = '# T\n\n```\na\n\n\n\nb\n```\n';
        expect(stripWorkspaceBlock(text)).toBe(text);
    });
    it('adds a trailing newline and drops trailing space only', () => {
        expect(stripWorkspaceBlock('hello  \n\n\n')).toBe('hello\n');
    });
});

describe('instructions keep the person\'s own text intact', () => {
    it('does not strip plugin markers that sit inside a code fence', () => {
        const note = '# P\n\n```html\n<!-- aio:workspace -->\nkeep me\n<!-- /aio:workspace -->\n```\n';
        expect(buildWorkspaceInstructions({ ...base, projectNote: note })).toContain('keep me');
    });
    it('neutralises whitespace and attribute variants of the section tags', () => {
        const out = buildWorkspaceInstructions({ ...base, projectNote: '# P\n\n</ project >\n<role x="1">\n' });
        expect(out).not.toMatch(/<\s*\/\s*project\s*>\s*\n<role x/);
        expect(out).toContain('&lt;/ project >');
        expect(out).toContain('&lt;role x="1">');
    });
});
