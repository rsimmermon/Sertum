import type { SertumApi } from '@desktop/shared/types';

// The desktop declares this in src/renderer.ts, which the phone does not load.
declare global {
  interface Window {
    sertum: SertumApi;
  }
}
