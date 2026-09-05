import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';

/**
 * ESLint flat config REPLACES a rule value when a later config sets the same
 * rule key for a matching file — it never merges. A narrow block that listed
 * only its own selectors would therefore silently switch off every selector a
 * broader block had set for the same file, and nothing would fail: lint would
 * still pass, just without the guard.
 *
 * That is exactly what happened when the plugin-data guard was added — all four
 * note-edit write-seam selectors were disabled for the command layer. These
 * tests assert the EFFECTIVE rule per representative file, which is the only
 * way to observe replacement semantics.
 */
// Use ESLint's Node API rather than shelling out: `npx` is a shell shim that
// spawnSync rejects with EINVAL on Windows, and a linked git worktree has no
// local node_modules to point a script path at.
let eslint: ESLint;
beforeAll(() => { eslint = new ESLint(); });

async function effectiveSelectors(file: string): Promise<string[]> {
    const config = await eslint.calculateConfigForFile(file) as {
        rules?: Record<string, unknown>;
    };
    const rule = config.rules?.['no-restricted-syntax'];
    if (!Array.isArray(rule)) return [];
    return rule.slice(1).map((e: { selector: string }) => e.selector);
}

const NOTE_EDIT = "CallExpression[callee.name='insertAtCursor']";
const VAULT_MODIFY = "CallExpression[callee.property.name='modify'][callee.object.property.name='vault']";
const SAVE_DATA = "CallExpression[callee.property.name='saveData']";
const UPDATE_PLUGIN_DATA = "CallExpression[callee.name='updatePluginData']";

describe('eslint guard composition', () => {
    it('the command layer keeps BOTH the note-edit and plugin-data guards', async () => {
        const sel = await effectiveSelectors('src/commands/summarizeCommands.ts');
        expect(sel).toContain(NOTE_EDIT);
        expect(sel).toContain(VAULT_MODIFY);
        expect(sel).toContain(SAVE_DATA);
    });

    it('settings surfaces are barred from both saveData and updatePluginData', async () => {
        const sel = await effectiveSelectors('src/main.ts');
        expect(sel).toContain(SAVE_DATA);
        expect(sel).toContain(UPDATE_PLUGIN_DATA);
    });

    it('an ordinary service file is barred from saveData only', async () => {
        const sel = await effectiveSelectors('src/services/newsletter/newsletterService.ts');
        expect(sel).toContain(SAVE_DATA);
        expect(sel).not.toContain(UPDATE_PLUGIN_DATA);
    });

    it('the store module itself is exempt — it owns the mechanism', async () => {
        expect(await effectiveSelectors('src/core/pluginDataStore.ts')).not.toContain(SAVE_DATA);
    });
}, 120_000);
