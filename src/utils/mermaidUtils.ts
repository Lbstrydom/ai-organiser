/**
 * Mermaid Diagram Utilities
 * Block detection, fingerprint re-resolution, and syntax validation.
 */

export interface MermaidBlock {
    code: string;           // Raw Mermaid code (without fences)
    startLine: number;      // Line number of opening ```mermaid
    endLine: number;        // Line number of closing ```
    startOffset: number;    // Character offset of start of opening ```mermaid
    endOffset: number;      // Character offset of end of closing ```
}

/** Known Mermaid diagram type keywords (first word of first line) */
const KNOWN_DIAGRAM_TYPES = [
    'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
    'stateDiagram-v2', 'erDiagram', 'gantt', 'pie', 'mindmap', 'timeline',
    'journey', 'quadrantChart', 'sankey', 'xychart', 'xychart-beta',
    'block', 'gitGraph', 'requirementDiagram', 'c4Context', 'c4Container',
    'c4Component', 'c4Dynamic', 'c4Deployment',
];

/**
 * Find ALL ```mermaid blocks in content, returning their positions.
 * Handles fence-depth tracking to skip nested code blocks.
 */
export function findAllMermaidBlocks(content: string): MermaidBlock[] {
    const lines = content.split('\n');
    const blocks: MermaidBlock[] = [];

    let i = 0;
    let charOffset = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (line.trimEnd() === '```mermaid') {
            const startLine = i;
            const startOffset = charOffset;

            // Scan for matching closing fence
            let j = i + 1;
            let codeOffset = charOffset + line.length + 1; // +1 for \n
            const codeLines: string[] = [];

            while (j < lines.length) {
                const innerLine = lines[j];
                if (innerLine.trimEnd() === '```') {
                    // Found closing fence
                    const endLine = j;
                    const endOffset = codeOffset + innerLine.length;
                    const code = codeLines.join('\n');

                    blocks.push({
                        code,
                        startLine,
                        endLine,
                        startOffset,
                        endOffset,
                    });

                    i = j + 1;
                    charOffset = endOffset + 1; // +1 for \n
                    break;
                }
                codeLines.push(innerLine);
                codeOffset += innerLine.length + 1;
                j++;
            }

            if (j >= lines.length) {
                // Malformed block (no closing fence) — skip
                charOffset += line.length + 1;
                i++;
            }
        } else {
            charOffset += line.length + 1;
            i++;
        }
    }

    return blocks;
}

/**
 * Find the nearest ```mermaid block to the cursor position.
 * Priority:
 *   1. Block that contains the cursor line
 *   2. Nearest block by line distance (alternating up/down)
 */
export function findNearestMermaidBlock(content: string, cursorLine: number): MermaidBlock | null {
    const blocks = findAllMermaidBlocks(content);
    if (blocks.length === 0) return null;

    // Check if cursor is inside any block (between startLine and endLine inclusive)
    const containing = blocks.find(b => cursorLine >= b.startLine && cursorLine <= b.endLine);
    if (containing) return containing;

    // Find nearest by distance to block midpoint
    let nearest: MermaidBlock | null = null;
    let minDist = Infinity;

    for (const block of blocks) {
        const midLine = Math.floor((block.startLine + block.endLine) / 2);
        const dist = Math.abs(cursorLine - midLine);
        if (dist < minDist) {
            minDist = dist;
            nearest = block;
        }
    }

    return nearest;
}

/**
 * Replace a specific mermaid block in content with new code.
 * Returns the modified content string.
 */
export function replaceMermaidBlock(content: string, block: MermaidBlock, newCode: string): string {
    const before = content.slice(0, block.startOffset);
    const after = content.slice(block.endOffset);
    const newFence = '```mermaid\n' + newCode + '\n```';
    return before + newFence + after;
}

/**
 * Re-resolve a block by composite fingerprint in potentially-changed content.
 * Uses first 80 chars of original code + line-distance proximity (±30 lines
 * from originalStartLine). Prevents false matches when multiple small diagrams
 * share identical opening lines.
 * Returns updated MermaidBlock with current positions, or null if no match found.
 */
export function resolveBlockByFingerprint(
    content: string,
    fingerprint: string,
    originalStartLine: number
): MermaidBlock | null {
    const blocks = findAllMermaidBlocks(content);
    if (blocks.length === 0) return null;

    const PROXIMITY_WINDOW = 30;

    // Filter: blocks whose code starts with the fingerprint AND are within proximity
    const candidates = blocks.filter(block => {
        const codeFingerprint = block.code.slice(0, 80);
        const fingerprintMatch = codeFingerprint === fingerprint || block.code.startsWith(fingerprint);
        const lineDistance = Math.abs(block.startLine - originalStartLine);
        return fingerprintMatch && lineDistance <= PROXIMITY_WINDOW;
    });

    if (candidates.length === 0) return null;

    // Pick the closest to originalStartLine
    return candidates.reduce((best, candidate) => {
        const bestDist = Math.abs(best.startLine - originalStartLine);
        const candDist = Math.abs(candidate.startLine - originalStartLine);
        return candDist < bestDist ? candidate : best;
    }, candidates[0]);
}

/**
 * Lightweight Mermaid syntax validation (no rendering required).
 * Returns { valid: boolean; warnings: string[] }.
 * All results are ADVISORY ONLY — never block rendering.
 */
export function validateMermaidSyntax(code: string): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    if (!code?.trim()) {
        warnings.push('Diagram is empty');
        return { valid: false, warnings };
    }

    const lines = code.trim().split('\n');
    const firstLine = lines[0].trim().toLowerCase();

    checkDiagramType(lines[0].trim(), firstLine, warnings);
    checkBracketBalance(code, warnings);

    if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph')) {
        checkFlowchartRules(lines, warnings);
    }

    if (firstLine.startsWith('classdiagram')) {
        checkClassDiagramRules(lines, warnings);
    }

    return { valid: warnings.length === 0, warnings };
}

function checkDiagramType(rawFirst: string, lowerFirst: string, warnings: string[]): void {
    const hasKnownType = KNOWN_DIAGRAM_TYPES.some(t => lowerFirst.startsWith(t.toLowerCase()));
    if (!hasKnownType) {
        warnings.push(`Unrecognised diagram type: "${rawFirst}"`);
    }
}

function checkBracketBalance(code: string, warnings: string[]): void {
    const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
    for (const [open, close] of pairs) {
        let depth = 0;
        let unbalanced = false;
        for (const ch of code) {
            if (ch === open) {
                depth++;
            } else if (ch === close) {
                depth--;
                if (depth < 0) { unbalanced = true; break; }
            }
        }
        if (depth !== 0 || unbalanced) {
            warnings.push(`Unbalanced brackets: ${open}${close}`);
        }
    }
}

function checkFlowchartRules(lines: string[], warnings: string[]): void {
    // Arrow presence
    const contentLines = lines.slice(1).filter(l => l.trim() && !l.trim().startsWith('%'));
    const hasArrows = contentLines.some(l => /-->/.test(l));
    if (contentLines.length > 2 && !hasArrows) {
        warnings.push('Flowchart appears to have no arrow connections (-->)');
    }

    // Subgraph nesting depth
    let subgraphDepth = 0;
    let maxSubgraphDepth = 0;
    for (const line of lines.slice(1)) {
        if (/^\s*subgraph\b/.test(line)) {
            subgraphDepth++;
            maxSubgraphDepth = Math.max(maxSubgraphDepth, subgraphDepth);
        } else if (/^\s*end\b/.test(line)) {
            subgraphDepth = Math.max(0, subgraphDepth - 1);
        }
    }
    if (maxSubgraphDepth > 3) {
        warnings.push(`Deep subgraph nesting (${maxSubgraphDepth} levels) may not render correctly`);
    }

    // classDef completeness
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^classDef\s*$/.test(trimmed)) {
            warnings.push('classDef missing class name');
        } else if (/^classDef\s+\S+\s*$/.test(trimmed)) {
            warnings.push(`classDef "${trimmed.split(/\s+/)[1]}" has no style properties`);
        }
    }
}

function checkClassDiagramRules(lines: string[], warnings: string[]): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const classDefPattern = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\{|$)/;
    for (const line of lines.slice(1)) {
        const match = classDefPattern.exec(line);
        if (match) {
            const name = match[1];
            if (seen.has(name)) {
                duplicates.add(name);
            } else {
                seen.add(name);
            }
        }
    }
    if (duplicates.size > 0) {
        warnings.push(`Duplicate class definitions: ${[...duplicates].join(', ')}`);
    }
}

/**
 * Build a fingerprint for a MermaidBlock (first 80 chars of code).
 */
export function buildBlockFingerprint(block: MermaidBlock): string {
    return block.code.slice(0, 80);
}

/**
 * Check whether the cursor line is inside a ```mermaid...``` fence.
 */
export function cursorInsideMermaidFence(content: string, cursorLine: number): boolean {
    const blocks = findAllMermaidBlocks(content);
    return blocks.some(b => cursorLine > b.startLine && cursorLine < b.endLine);
}

/**
 * Extract human-readable node labels from a Mermaid diagram code string.
 * Handles common label syntaxes: A[Label], A(Label), A{Label}, A((Label)),
 * A>Label], A{{Label}}.  Returns unique non-empty labels.
 */
export function extractMermaidNodeLabels(code: string): string[] {
    const seen = new Set<string>();
    const patterns = [
        /[A-Za-z0-9_]+\{\{([^}]+)\}\}/g,    // A{{Label}}  (hexagon) — must come before {}
        /[A-Za-z0-9_]+\(\(([^)]+)\)\)/g,    // A((Label))  (circle) — must come before ()
        /[A-Za-z0-9_]+\[([^\]]+)\]/g,        // A[Label]
        /[A-Za-z0-9_]+\(([^)]+)\)/g,         // A(Label)
        /[A-Za-z0-9_]+\{([^}]+)\}/g,         // A{Label}
        /[A-Za-z0-9_]+>([^\]]+)\]/g,         // A>Label]
    ];
    for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            const label = m[1].trim();
            if (label && !seen.has(label)) seen.add(label);
        }
    }
    return [...seen];
}
