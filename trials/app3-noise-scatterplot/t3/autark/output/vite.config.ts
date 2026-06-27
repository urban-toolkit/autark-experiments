import { ViteDevServer, defineConfig } from 'vite';

// autk-db, autk-map and autk-plot ship as pre-built ESM bundles that contain
// WASM and web workers. Vite's dependency optimizer must NOT pre-bundle them,
// but the dev server watcher should still watch them inside node_modules.
export function pluginWatchNodeModules(modules: string[]) {
  const pattern = `/node_modules\\/(?!${modules.join('|')}).*/`;
  return {
    name: 'watch-node-modules',
    configureServer: (server: ViteDevServer): void => {
      server.watcher.options = {
        ...server.watcher.options,
        ignored: [new RegExp(pattern), '**/.git/**'],
      };
    },
  };
}

export default defineConfig({
  plugins: [pluginWatchNodeModules(['autk-map', 'autk-db', 'autk-plot'])],
  optimizeDeps: {
    exclude: ['autk-db', 'autk-map', 'autk-plot'],
  },
  server: {
    port: 3005,
    strictPort: true,
    fs: {
      allow: ['..'],
    },
    cors: {
      origin: '*',
      allowedHeaders: 'Range, Content-Type, Authorization',
      exposedHeaders: 'Content-Range',
    },
  },
  preview: {
    port: 3005,
    strictPort: true,
  },
});
