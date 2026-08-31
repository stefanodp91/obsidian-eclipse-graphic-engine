import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        babylon: resolve(import.meta.dirname, 'src/babylon.ts'),
        cache: resolve(import.meta.dirname, 'src/cache.ts'),
        react: resolve(import.meta.dirname, 'src/react.ts'),
        reactylon: resolve(import.meta.dirname, 'src/reactylon.ts'),
      },
      formats: ['es'],
    },
    sourcemap: true,
    rollupOptions: {
      external: (id) => id === 'react' || id === 'reactylon' || id.startsWith('@babylonjs/'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
