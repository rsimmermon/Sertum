import { defineConfig } from 'vite';

// node-pty is a native module: it must stay external so Node resolves the
// prebuilt .node binary at runtime instead of Rollup trying to bundle it.
//
// bufferutil and utf-8-validate are ws's optional speed-ups, loaded in a
// try/catch. Left to Rollup, a missing one becomes a throw when the bundle loads,
// so sertumd dies before it can log anything and every session goes with it.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    },
  },
});
