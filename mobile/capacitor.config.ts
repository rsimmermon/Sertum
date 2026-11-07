import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // The desktop bundle is dev.sertum.app; this is its sibling.
  appId: 'dev.sertum.mobile',
  appName: 'Sertum',
  webDir: 'dist',
  // The app is always dark, so the bars' icons have to be light to be seen.
  plugins: { SystemBars: { style: 'DARK' } },
};

export default config;
