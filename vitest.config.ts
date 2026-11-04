import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // macOS writes AppleDouble `._*` companions on non-HFS volumes (e.g. exFAT).
    exclude: ['**/node_modules/**', '**/._*'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Integration tests share one test database; run files serially for isolation.
    fileParallelism: false,
  },
});
