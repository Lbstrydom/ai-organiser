import tsparser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
    ...obsidianmd.configs.recommended,
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
            'obsidianmd/ui/sentence-case': ['warn', {
                brands: ['AI Organiser', 'Obsidian', 'Kindle', 'YouTube', 'Gemini', 'Claude', 'OpenAI', 'Groq', 'Cohere', 'Ollama', 'NotebookLM', 'Zotero', 'Mermaid', 'GTD', 'Anki', 'Brainscape', 'Bright Data', 'Tavily', 'Voyage AI', 'Siliconflow', 'Supabase', 'Whisper', 'Electron', 'Node.js', 'Markdown', 'Zoom', 'Amazon', 'Gmail', 'Google', 'Anthropic', 'Readability', 'Dataview', 'Bases', 'Dataverse'],
                acronyms: ['AI', 'LLM', 'API', 'URL', 'PDF', 'CSV', 'HTML', 'CSS', 'JS', 'PPTX', 'DOCX', 'RAG', 'KPI', 'GTD', 'SSE', 'ONNX', 'WASM', 'CDP', 'FFmpeg', 'ASIN', 'ISBN', 'DOI', 'SERP', 'ID', 'OK', 'YAML', 'JSON', 'SVG', 'PNG', 'JPG', 'JPEG', 'MP3', 'MP4', 'MB', 'GB', 'KB', 'RTF', 'TXT', 'XLSX', 'IANA', 'UA', 'TLDR', 'TL;DR', 'UI', 'UX', 'GPU', 'CPU', 'RAM', 'USB', 'MIME', 'UTF', 'ASCII', 'HTTP', 'HTTPS', 'TCP', 'IP', 'DNS', 'JWT', 'OAuth', 'YAML'],
            }],

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
        ignores: ['tests/**', 'main.js', 'scripts/**', 'docs/**', '*.config.*'],
    },
]);
