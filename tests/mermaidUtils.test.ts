/**
 * Tests for mermaidUtils.ts
 */

import {
    findAllMermaidBlocks,
    findNearestMermaidBlock,
    replaceMermaidBlock,
    resolveBlockByFingerprint,
    validateMermaidSyntax,
    buildBlockFingerprint,
    cursorInsideMermaidFence,
} from '../src/utils/mermaidUtils';

// ── findAllMermaidBlocks ──────────────────────────────────────────────────────

describe('findAllMermaidBlocks', () => {
    it('returns empty array when no blocks exist', () => {
        expect(findAllMermaidBlocks('no mermaid here')).toEqual([]);
    });

    it('finds a single block', () => {
        const content = '# Title\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nrest';
        const blocks = findAllMermaidBlocks(content);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].code).toBe('flowchart TD\n  A --> B');
        expect(blocks[0].startLine).toBe(2);
        expect(blocks[0].endLine).toBe(5);
    });

    it('finds multiple blocks', () => {
        const content = '```mermaid\ngraph LR\n  A-->B\n```\n\nsome text\n\n```mermaid\nmindmap\n  root\n```';
        const blocks = findAllMermaidBlocks(content);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].code).toBe('graph LR\n  A-->B');
        expect(blocks[1].code).toBe('mindmap\n  root');
    });

    it('handles 3 blocks of various types', () => {
        const lines = [
            '```mermaid',
            'flowchart TD',
            '  A --> B',
            '```',
            '',
            '```mermaid',
            'sequenceDiagram',
            '  A->>B: hello',
            '```',
            '',
            '```mermaid',
            'pie title Pets',
            '  "Dogs" : 40',
            '```',
        ];
        const blocks = findAllMermaidBlocks(lines.join('\n'));
        expect(blocks).toHaveLength(3);
        expect(blocks[0].code).toContain('flowchart');
        expect(blocks[1].code).toContain('sequenceDiagram');
        expect(blocks[2].code).toContain('pie');
    });

    it('handles a block with empty content', () => {
        const content = '```mermaid\n```';
        const blocks = findAllMermaidBlocks(content);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].code).toBe('');
    });

    it('ignores regular code fences (not mermaid)', () => {
        const content = '```typescript\nconst x = 1;\n```\n\n```mermaid\ngraph TD\n  A-->B\n```';
        const blocks = findAllMermaidBlocks(content);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].code).toContain('graph TD');
    });

    it('handles Windows line endings (CRLF)', () => {
        const content = '```mermaid\r\nflowchart TD\r\n  A --> B\r\n```';
        // CRLF: closing ``` won't match trimEnd() === '```' because line ends with \r
        // Intentionally skip — platform normalisation is caller responsibility
        // But verify no crash
        expect(() => findAllMermaidBlocks(content)).not.toThrow();
    });

    it('records startOffset and endOffset correctly', () => {
        const content = 'abc\n```mermaid\nflowchart TD\n```\ndef';
        const blocks = findAllMermaidBlocks(content);
        expect(blocks).toHaveLength(1);
        // startOffset should be 4 (after "abc\n")
        expect(blocks[0].startOffset).toBe(4);
        expect(content.slice(blocks[0].startOffset, blocks[0].endOffset)).toBe('```mermaid\nflowchart TD\n```');
    });
});

// ── findNearestMermaidBlock ───────────────────────────────────────────────────

describe('findNearestMermaidBlock', () => {
    it('returns null when no blocks', () => {
        expect(findNearestMermaidBlock('no mermaid', 0)).toBeNull();
    });

    it('returns the block when cursor is inside it', () => {
        const content = 'line0\n```mermaid\nflowchart TD\n  A-->B\n```\nline5';
        // cursor on line 3 (inside the fence lines 1-4)
        const block = findNearestMermaidBlock(content, 3);
        expect(block).not.toBeNull();
        expect(block!.code).toContain('flowchart TD');
    });

    it('returns nearest block when cursor is outside all blocks', () => {
        const content = '```mermaid\ngraph LR\n  A-->B\n```\n\n\n\n\n\n\ncursor here';
        // cursor on line 10 (after the block which ends at line 3)
        const block = findNearestMermaidBlock(content, 10);
        expect(block).not.toBeNull();
        expect(block!.code).toContain('graph LR');
    });

    it('prefers block containing cursor over a closer block', () => {
        const lines = [
            '```mermaid',  // 0
            'graph LR',    // 1
            '  A-->B',     // 2
            '```',         // 3
            '',            // 4
            '```mermaid',  // 5
            'mindmap',     // 6
            '  root',      // 7
            '```',         // 8
        ];
        const content = lines.join('\n');
        // cursor on line 6 (inside second block)
        const block = findNearestMermaidBlock(content, 6);
        expect(block!.code).toContain('mindmap');
    });

    it('handles cursor before all blocks', () => {
        const content = 'title\n\n```mermaid\nflowchart TD\n  A-->B\n```';
        const block = findNearestMermaidBlock(content, 0);
        expect(block).not.toBeNull();
    });
});

// ── replaceMermaidBlock ───────────────────────────────────────────────────────

describe('replaceMermaidBlock', () => {
    it('replaces block in the middle of content', () => {
        const content = 'before\n```mermaid\nflowchart TD\n  A-->B\n```\nafter';
        const blocks = findAllMermaidBlocks(content);
        const result = replaceMermaidBlock(content, blocks[0], 'graph LR\n  X-->Y');
        expect(result).toContain('before\n');
        expect(result).toContain('```mermaid\ngraph LR\n  X-->Y\n```');
        expect(result).toContain('\nafter');
        expect(result).not.toContain('flowchart TD');
    });

    it('replaces block at the start of content', () => {
        const content = '```mermaid\nflowchart TD\n  A-->B\n```\nafter';
        const blocks = findAllMermaidBlocks(content);
        const result = replaceMermaidBlock(content, blocks[0], 'mindmap\n  root');
        expect(result.startsWith('```mermaid\nmindmap')).toBe(true);
        expect(result).toContain('after');
    });

    it('replaces block at the end of content', () => {
        const content = 'before\n```mermaid\nflowchart TD\n  A-->B\n```';
        const blocks = findAllMermaidBlocks(content);
        const result = replaceMermaidBlock(content, blocks[0], 'sequenceDiagram\n  A->>B: hi');
        expect(result).toContain('before\n');
        expect(result.endsWith('```')).toBe(true);
        expect(result).not.toContain('flowchart');
    });

    it('preserves content before and after when replacing the second of two blocks', () => {
        const content = '```mermaid\ngraph LR\n  A-->B\n```\nmiddle\n```mermaid\ngraph TD\n  X-->Y\n```\nend';
        const blocks = findAllMermaidBlocks(content);
        const result = replaceMermaidBlock(content, blocks[1], 'pie\n  "A": 50');
        expect(result).toContain('graph LR');   // first block untouched
        expect(result).toContain('middle');
        expect(result).toContain('pie');
        expect(result).not.toContain('graph TD');
        expect(result).toContain('end');
    });
});

// ── resolveBlockByFingerprint ─────────────────────────────────────────────────

describe('resolveBlockByFingerprint', () => {
    const diagram = 'flowchart TD\n  A --> B\n  B --> C';
    const content = `header\n\`\`\`mermaid\n${diagram}\n\`\`\`\nfooter`;

    it('resolves block by exact fingerprint', () => {
        const blocks = findAllMermaidBlocks(content);
        const fp = buildBlockFingerprint(blocks[0]);
        const resolved = resolveBlockByFingerprint(content, fp, blocks[0].startLine);
        expect(resolved).not.toBeNull();
        expect(resolved!.code).toBe(diagram);
    });

    it('resolves when content has shifted (lines added before)', () => {
        const shifted = 'extra line 1\nextra line 2\n' + content;
        const blocks = findAllMermaidBlocks(content);
        const fp = buildBlockFingerprint(blocks[0]);
        const originalLine = blocks[0].startLine; // e.g. 1

        const resolved = resolveBlockByFingerprint(shifted, fp, originalLine);
        expect(resolved).not.toBeNull();
        expect(resolved!.code).toBe(diagram);
    });

    it('returns null when fingerprint not found', () => {
        const resolved = resolveBlockByFingerprint(content, 'nonexistent fingerprint xxxxx', 1);
        expect(resolved).toBeNull();
    });

    it('returns null when block is outside ±30 line window', () => {
        // Build content with block at line 35 and fingerprint claiming it was at line 0
        const padding = Array(35).fill('line').join('\n') + '\n';
        const farContent = padding + '```mermaid\nflowchart TD\n  A-->B\n```';
        const blocks = findAllMermaidBlocks(farContent);
        const fp = buildBlockFingerprint(blocks[0]); // block is at line 35
        // Ask for originalStartLine = 0, block is at 35: distance = 35 > 30 → null
        const resolved = resolveBlockByFingerprint(farContent, fp, 0);
        expect(resolved).toBeNull();
    });

    it('picks nearest when multiple blocks share the same opening', () => {
        // Two blocks both starting with "flowchart TD\n  A --> B" (within 80 chars)
        const twoBlocks = [
            '```mermaid',
            'flowchart TD',
            '  A --> B',
            '```',
            ...Array(5).fill(''),
            '```mermaid',
            'flowchart TD',
            '  A --> B',
            '  C --> D',
            '```',
        ].join('\n');

        const blocks = findAllMermaidBlocks(twoBlocks);
        const fp = buildBlockFingerprint(blocks[0]); // first 80 chars of block[0]

        // originalStartLine matches block[0] exactly
        const resolved = resolveBlockByFingerprint(twoBlocks, fp, blocks[0].startLine);
        expect(resolved!.startLine).toBe(blocks[0].startLine);
    });

    it('returns null for empty content', () => {
        expect(resolveBlockByFingerprint('', 'fp', 0)).toBeNull();
    });
});

// ── validateMermaidSyntax ─────────────────────────────────────────────────────

describe('validateMermaidSyntax', () => {
    it('returns valid for a well-formed flowchart', () => {
        const { valid, warnings } = validateMermaidSyntax('flowchart TD\n  A --> B\n  B --> C');
        expect(valid).toBe(true);
        expect(warnings).toHaveLength(0);
    });

    it('returns valid for a well-formed mindmap', () => {
        const { valid, warnings } = validateMermaidSyntax('mindmap\n  root((Main))\n    Branch1\n    Branch2');
        expect(valid).toBe(true);
        expect(warnings).toHaveLength(0);
    });

    it('returns valid for a sequenceDiagram', () => {
        const { valid, warnings } = validateMermaidSyntax('sequenceDiagram\n  A->>B: Hello\n  B-->>A: Reply');
        expect(valid).toBe(true);
        expect(warnings).toHaveLength(0);
    });

    it('warns about missing diagram type keyword', () => {
        const { valid, warnings } = validateMermaidSyntax('A --> B\nB --> C');
        expect(valid).toBe(false);
        expect(warnings.some(w => w.includes('Unrecognised diagram type'))).toBe(true);
    });

    it('warns about empty input', () => {
        const { valid, warnings } = validateMermaidSyntax('');
        expect(valid).toBe(false);
        expect(warnings.length).toBeGreaterThan(0);
    });

    it('warns about unbalanced parentheses', () => {
        const { valid, warnings } = validateMermaidSyntax('flowchart TD\n  A((open\n  B --> A');
        expect(warnings.some(w => w.includes('()'))).toBe(true);
    });

    it('warns about unbalanced square brackets', () => {
        const { valid, warnings } = validateMermaidSyntax('flowchart TD\n  A[unclosed\n  B --> A');
        expect(warnings.some(w => w.includes('[]'))).toBe(true);
    });

    it('returns advisory warnings, never hard errors (soft validation)', () => {
        // Even with warnings, the function returns a result (never throws)
        const result = validateMermaidSyntax('completely invalid {{{{{}}}}');
        expect(result).toHaveProperty('valid');
        expect(result).toHaveProperty('warnings');
        expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('accepts graph as a valid diagram type', () => {
        const { valid } = validateMermaidSyntax('graph LR\n  A --> B');
        expect(valid).toBe(true);
    });

    it('accepts stateDiagram-v2', () => {
        const { valid } = validateMermaidSyntax('stateDiagram-v2\n  [*] --> A\n  A --> [*]');
        expect(valid).toBe(true);
    });

    it('handles whitespace-only input', () => {
        const { valid, warnings } = validateMermaidSyntax('   \n  \n  ');
        expect(valid).toBe(false);
        expect(warnings.length).toBeGreaterThan(0);
    });
});

// ── buildBlockFingerprint ─────────────────────────────────────────────────────

describe('buildBlockFingerprint', () => {
    it('returns first 80 chars of code', () => {
        const code = 'a'.repeat(100);
        const blocks = findAllMermaidBlocks('```mermaid\n' + code + '\n```');
        const fp = buildBlockFingerprint(blocks[0]);
        expect(fp).toBe('a'.repeat(80));
    });

    it('returns full code when shorter than 80 chars', () => {
        const blocks = findAllMermaidBlocks('```mermaid\nflowchart TD\n  A-->B\n```');
        const fp = buildBlockFingerprint(blocks[0]);
        expect(fp).toBe('flowchart TD\n  A-->B');
    });
});

// ── cursorInsideMermaidFence ──────────────────────────────────────────────────

describe('cursorInsideMermaidFence', () => {
    const content = 'line0\n```mermaid\nflowchart TD\n  A-->B\n```\nline5';
    //                line:  0         1             2            3       4     5

    it('returns true when cursor is on a code line inside fence', () => {
        expect(cursorInsideMermaidFence(content, 2)).toBe(true);
        expect(cursorInsideMermaidFence(content, 3)).toBe(true);
    });

    it('returns false when cursor is on the opening fence line', () => {
        expect(cursorInsideMermaidFence(content, 1)).toBe(false);
    });

    it('returns false when cursor is on the closing fence line', () => {
        expect(cursorInsideMermaidFence(content, 4)).toBe(false);
    });

    it('returns false when cursor is outside any fence', () => {
        expect(cursorInsideMermaidFence(content, 0)).toBe(false);
        expect(cursorInsideMermaidFence(content, 5)).toBe(false);
    });

    it('returns false when there are no mermaid blocks', () => {
        expect(cursorInsideMermaidFence('no blocks here', 0)).toBe(false);
    });
});
