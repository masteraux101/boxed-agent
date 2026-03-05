import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.PUBLIC_URL || '/',
  build: {
    outDir: 'dist',
  },
});
