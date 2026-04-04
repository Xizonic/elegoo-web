import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8088',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8088',
      },
    },
  },
});
