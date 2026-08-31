import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/obsidian-eclipse-graphic-engine/',
  plugins: [
    react({
      babel: { plugins: ['babel-plugin-reactylon'] },
    }),
  ],
  resolve: {
    alias: {
      '@obsidian-eclipse/endless-shark-models': fileURLToPath(new URL('./models/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 4173 },
  build: { target: 'es2022' },
});
