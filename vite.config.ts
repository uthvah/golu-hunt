import { defineConfig } from 'vite';

// base './' so the build works from any GitHub Pages sub-path.
// annotate.html is a dev-only tool (npm run dev → /annotate.html) and is not built.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2022', rollupOptions: { input: 'index.html' } },
});
