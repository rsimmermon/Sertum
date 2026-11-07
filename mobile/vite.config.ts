import path from 'node:path';
import { defineConfig } from 'vite';

// The renderer and shared contracts are imported from the desktop tree rather
// than copied, because a mirror with two copies of its UI stops being one.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  resolve: {
    alias: { '@desktop': path.resolve(__dirname, '../src') },
    // katex is resolved from the repo's own node_modules for desktop code.
    dedupe: ['katex'],
  },
  server: { fs: { allow: ['..'] } },
});
