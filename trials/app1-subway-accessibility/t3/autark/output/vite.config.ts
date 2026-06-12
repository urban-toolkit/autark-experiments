import { ViteDevServer, defineConfig } from 'vite';

// autk-db / autk-map ship pre-bundled ESM that must not be pre-optimized or
// ignored by the dev watcher. This plugin keeps them watched while excluding
// the rest of node_modules.
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
