// `vitest/config` rather than `vite` so the `test` block below is typed.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so a build can be served from a subdirectory
  // (GitHub Pages project sites, a folder on a static host) without rewriting.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Tesseract and the chart library are both large and change on a
        // different cadence than app code; splitting them keeps a routine
        // deploy from invalidating megabytes of cached vendor bundle.
        manualChunks: {
          ocr: ['tesseract.js'],
          charts: ['recharts'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
