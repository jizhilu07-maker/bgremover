import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs so the build works from any sub-path (GitHub Pages serves /<repo>/).
  base: './',
  plugins: [react()],
  // transformers.js ships prebuilt ESM with dynamic imports that break Vite's dep pre-bundling.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
});
