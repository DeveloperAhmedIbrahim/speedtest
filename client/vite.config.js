import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Where the LibreSpeed `server` folder is actually served from.
  const target = env.SPEEDTEST_PROXY_TARGET || 'http://localhost';

  return {
    plugins: [react()],
    // Built files are served from /var/www/html/speedtest/, not the domain root.
    base: env.VITE_BASE || '/',
    server: {
      proxy: {
        // In dev, /server/* is proxied so there is no CORS and no mixed origin.
        '/server': { target, changeOrigin: true, secure: false },
      },
    },
  };
});
