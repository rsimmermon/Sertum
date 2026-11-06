import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // The desktop bundle is dev.sertum.app; this is its sibling.
  appId: 'dev.sertum.mobile',
  appName: 'Sertum',
  webDir: 'dist',
};

export default config;
