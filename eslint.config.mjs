import tsparser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import obsidianmdImport from 'eslint-plugin-obsidianmd';

// eslint-plugin-obsidianmd 0.3.0 moved configs under a `default` export; 0.1.x
// exposed them at the top level. Support both so a version bump can't break lint.
const obsidianmd = obsidianmdImport.configs ? obsidianmdImport : obsidianmdImport.default;

export default defineConfig([
    ...obsidianmd.configs.recommendedWithLocalesEn,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: './tsconfig.build.json',
            },
        },
        rules: {
            // ── Obsidian-specific rules (match review bot) ─────────────
            'obsidianmd/no-static-styles-assignment': 'error',
            'obsidianmd/no-tfile-tfolder-cast': 'error',
            'obsidianmd/prefer-file-manager-trash-file': 'error',
            'obsidianmd/hardcoded-config-path': 'error',
            'obsidianmd/detach-leaves': 'error',
            'obsidianmd/platform': 'warn',
            'obsidianmd/regex-lookbehind': 'error',
            'obsidianmd/no-forbidden-elements': 'error',
            // Guard against using Obsidian APIs newer than manifest minAppVersion
            // (the review bot enforces this; keep it green locally too).
            'obsidianmd/no-unsupported-api': 'error',
            // Use plugin DEFAULTS for sentence-case — no custom brands/acronyms override.
            // Custom overrides cause mismatch with the review bot which uses pure defaults.
            // Domain acronyms (LLM, GTD, PPTX, etc.) are lowercased in en.ts to match.
            'obsidianmd/ui/sentence-case': 'error',

            // Not applicable to this project
            'obsidianmd/sample-names': 'off',
            'obsidianmd/no-sample-code': 'off',

            // ── TypeScript-eslint: relax overly strict rules ───────────
            // These fire on any `unknown` usage which is pervasive in plugin code
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',

            // Match review bot strictness — bot does NOT accept disables for these
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-deprecated': 'error',
            '@typescript-eslint/no-require-imports': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/require-await': 'error',

            // Bot requires descriptions on all eslint-disable comments
            'eslint-comments/require-description': 'off', // not available without plugin
            'eslint-comments/no-unused-disable': 'off',

            // Browser globals available in Obsidian
            'no-undef': 'off',
        },
    },
    {
        // ── Write-seam guard (command-layer-hardening M4) ──────────────
        // The command layer + multi-source service must mutate notes ONLY through
        // `applyNoteEdit` (src/services/noteEdit/**). Forbid direct editor / vault
        // writes here so the capture-then-verify write seam can't silently regress.
        // `src/services/noteEdit/**` is intentionally NOT in this list (it owns the
        // commit mechanism).
        files: [
            'src/commands/summarizeCommands.ts',
            'src/commands/translateCommands.ts',
            'src/services/multiSource/**/*.ts',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.object.name='editor'][callee.property.name=/^(setValue|replaceSelection|replaceRange)$/]",
                    message: 'Direct editor writes are forbidden here — route note mutations through applyNoteEdit (src/services/noteEdit).',
                },
                {
                    selector: "CallExpression[callee.name='insertAtCursor']",
                    message: 'insertAtCursor bypasses the write seam — use applyNoteEdit (src/services/noteEdit).',
                },
                {
                    selector: "CallExpression[callee.name='appendAsNewSections']",
                    message: 'appendAsNewSections bypasses the write seam — use applyNoteEdit (src/services/noteEdit).',
                },
                {
                    selector: "CallExpression[callee.property.name='modify'][callee.object.property.name='vault']",
                    message: 'vault.modify bypasses the write seam — use applyNoteEdit (src/services/noteEdit).',
                },
            ],
        },
    },
    {
        // `src/stubs/**` holds build-time CJS shims (e.g. tesseractNoop.cjs) aliased
        // in by esbuild — they are NOT plugin source and are not in tsconfig.build's
        // include, so the typed obsidianmd rules (which need parserServices) throw on
        // them ("don't have parserOptions set to generate type information"). They carry
        // no Obsidian-API patterns, so excluding them from lint is safe and keeps the
        // bot-parity ruleset runnable.
        ignores: ['tests/**', 'main.js', 'scripts/**', 'docs/**', 'src/stubs/**', '*.config.*'],
    },
]);
