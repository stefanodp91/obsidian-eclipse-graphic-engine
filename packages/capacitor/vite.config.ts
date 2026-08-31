import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        firebase: resolve(import.meta.dirname, 'src/observability/firebase.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    sourcemap: true,
    rollupOptions: {
      external: (id) => id === 'obsidian-eclipse-graphic-engine' || id.startsWith('@capacitor'),
    },
  },
});
