import { ViteDevServer, defineConfig } from 'vite';

// autk-db and autk-map ship as pre-built ESM bundles. Vite's dependency
// optimizer must not pre-bundle them (they contain WASM + web workers), and the
// dev-server file watcher must still watch them inside node_modules.
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
  plugins: [pluginWatchNodeModules(['autk-map', 'autk-db'])],
  optimizeDeps: {
    exclude: ['autk-db', 'autk-map'],
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
