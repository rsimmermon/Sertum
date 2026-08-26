import { defineConfig } from 'vite';

// node-pty is a native module: it must stay external so Node resolves the
// prebuilt .node binary at runtime instead of Rollup trying to bundle it.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
