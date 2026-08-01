import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  publicDir: '../public',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: false,
  },
  build: {
    outDir: '../frontend',
    emptyOutDir: true,
    target: ['es2021', 'chrome105'],
    minify: 'esbuild',
    sourcemap: false,
  },
});
