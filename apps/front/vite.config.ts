import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const CESIUM_BUILD = resolve(__dirname, '../../node_modules/cesium/Build/Cesium');
const CESIUM_DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2',
};

/** Serves Cesium's static assets under /cesium in dev and copies them on build. */
function cesiumAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'cesium-assets',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
        const file = join(CESIUM_BUILD, path);
        if (!file.startsWith(CESIUM_BUILD) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const d of CESIUM_DIRS) cpSync(join(CESIUM_BUILD, d), join(outDir, 'cesium', d), { recursive: true });
    },
  };
}

const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [cesiumAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    // The globe, and the providers admin page (/admin.html).
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), admin: resolve(__dirname, 'admin.html') } },
  },
});
