import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// One .env for the whole repo, kept next to package.json rather than inside client/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');

  return {
    plugins: [react()],
    envDir: repoRoot,
    // Set VITE_BASE=/speedtest/ if the built app lives in a subfolder.
    base: env.VITE_BASE || '/',
    build: { outDir: 'dist' },
  };
});
