import { defineConfig, type Plugin } from 'vitest/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load .md files as plain text strings, mirroring esbuild's `loader: { ".md": "text" }`. */
function markdownTextPlugin(): Plugin {
  return {
    name: 'markdown-text',
    transform(_, id) {
      if (!id.endsWith('.md')) return null;
      const content = readFileSync(id, 'utf-8');
      return { code: `export default ${JSON.stringify(content)};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [markdownTextPlugin()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/utils/**',
        'src/services/prompts/**',
        'src/services/configurationService.ts',
        'src/services/documentExtractionService.ts',
        'src/services/minutesService.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      // Mock obsidian module for tests - use absolute path
      obsidian: resolve(__dirname, 'tests/mocks/obsidian.ts'),
    },
  },
});
