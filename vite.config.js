import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ChibiFlex',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
