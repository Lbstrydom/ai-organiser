/**
 * The Obsidian review bot rejects a release when an eslint directive comment has no
 * description ("Unexpected undescribed directive comment", 1.1.2). The local config
 * cannot enforce eslint-comments/require-description (plugin not installed), so this
 * test does: every eslint-disable / eslint-enable directive under src/ must carry a
 * `-- reason` after its rule list.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const DIRECTIVE = /\beslint-(?:disable|enable)(?:-next-line|-line)?\b/;

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
        else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

describe('eslint directive comments', () => {
    it('every directive under src/ has a -- description', () => {
        const offenders: string[] = [];
        for (const file of listTsFiles(SRC)) {
            readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                const comment = line.match(/(?:\/\/|\/\*)\s*(eslint-[^\n]*)/);
                if (!comment || !DIRECTIVE.test(comment[1])) return;
                if (!/\s--\s*\S/.test(comment[1])) {
                    offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });
});
