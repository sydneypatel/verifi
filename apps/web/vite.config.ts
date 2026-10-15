import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In dev the web app calls /api/check and Vite forwards it to the API.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
