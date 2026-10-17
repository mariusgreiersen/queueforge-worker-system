import { defineConfig } from 'tsup';

// Bundles this app with the workspace-internal @queueforge/shared package (TypeScript source).
// Third-party dependencies stay external and are installed in the runtime image.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@queueforge/shared'],
});
