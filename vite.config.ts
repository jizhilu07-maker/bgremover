import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs so the build works from any sub-path (GitHub Pages serves /<repo>/).
  base: './',
  plugins: [react()],
  resolve: {
    // transformers.js imports the default build, whose JSEP WebGPU backend gives wrong masks on
    // some GPUs (NVIDIA RTX 40 + Chrome 157); the native WebGPU EP build computes them correctly.
    alias: [{ find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/webgpu' }],
  },
  // transformers.js ships prebuilt ESM with dynamic imports that break Vite's dep pre-bundling.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
});
