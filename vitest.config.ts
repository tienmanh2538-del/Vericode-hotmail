import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'tests/**/*.spec.ts',
      'tests/**/*.spec.tsx',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
