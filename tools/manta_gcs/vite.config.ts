/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  assetsInclude: ['**/*.png'],
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100_000_000,    // 全部内联 (含 top.png)
    chunkSizeWarningLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5173, open: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
