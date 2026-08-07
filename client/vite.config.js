import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API (and the PNGs it serves out of SQLite) live on the Express server;
// proxying keeps the browser on one origin so there is no CORS in the way.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
