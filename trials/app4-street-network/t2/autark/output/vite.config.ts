import { ViteDevServer, defineConfig } from 'vite';

// Keep autk-* packages out of Vite's dependency pre-bundling and watch them
// directly so their WebGPU/WASM assets resolve correctly in dev.
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
  plugins: [pluginWatchNodeModules(['autk-map', 'autk-db', 'autk-compute'])],
  optimizeDeps: {
    exclude: ['autk-db', 'autk-map', 'autk-compute'],
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
