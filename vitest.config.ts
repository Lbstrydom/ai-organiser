import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
