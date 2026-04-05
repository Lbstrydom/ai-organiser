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
            // Use plugin's DEFAULT brands list (bot uses it too).
            // Only supply extras via acronyms so our domain-specific acronyms are recognized.
            'obsidianmd/ui/sentence-case': ['error', {
                acronyms: [
                    // Plugin defaults (DEFAULT_ACRONYMS) — restated because the rule
                    // REPLACES the default list rather than merging:
                    'API', 'HTTP', 'HTTPS', 'URL', 'DNS', 'TCP', 'IP', 'SSH', 'TLS', 'SSL',
                    'FTP', 'SFTP', 'SMTP', 'JSON', 'XML', 'HTML', 'CSS', 'PDF', 'CSV', 'YAML',
                    'SQL', 'PNG', 'JPG', 'JPEG', 'GIF', 'SVG', '2FA', 'MFA', 'OAuth', 'JWT',
                    'LDAP', 'SAML', 'SDK', 'IDE', 'CLI', 'GUI', 'CRUD', 'REST', 'SOAP', 'CPU',
                    'GPU', 'RAM', 'SSD', 'USB', 'UI', 'OK', 'RSS', 'S3', 'WebDAV', 'ID',
                    'UUID', 'GUID', 'SHA', 'MD5', 'ASCII', 'UTF-8', 'UTF-16', 'DOM', 'CDN',
                    'FAQ', 'AI', 'ML',
                    // Plugin-specific additions:
                    'LLM', 'PPTX', 'DOCX', 'RAG', 'KPI', 'GTD', 'SSE', 'ONNX', 'WASM', 'CDP',
                    'ASIN', 'ISBN', 'DOI', 'SERP', 'MP3', 'MP4', 'MB', 'GB', 'KB', 'RTF',
                    'TXT', 'XLSX', 'IANA', 'UA', 'TLDR', 'UX', 'MIME', 'UTF', 'FFmpeg',
                ],
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
