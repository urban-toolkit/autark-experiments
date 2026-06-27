import { ViteDevServer, defineConfig } from 'vite';

// Keep the autk-* packages out of Vite's dep pre-bundling and file watcher.
// They ship pre-built ESM with WASM workers that must not be transformed.
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
    fs: {
      allow: ['..'],
    },
    cors: {
      origin: '*',
      allowedHeaders: 'Range, Content-Type, Authorization',
      exposedHeaders: 'Content-Range',
    },
  },
});
