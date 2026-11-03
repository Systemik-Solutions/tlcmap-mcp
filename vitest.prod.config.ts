import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/prod/**'],
    testTimeout: 90_000,
    fileParallelism: false,
  },
});
