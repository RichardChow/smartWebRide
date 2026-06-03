import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // Windows desktop environment can OOM when Vitest spawns multiple workers with jsdom.
    minWorkers: 1,
    maxWorkers: 1,
    exclude: [...configDefaults.exclude, 'tests/e2e/**']
  }
});
