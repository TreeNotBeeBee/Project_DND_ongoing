import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { thirdPartyNotices } from './scripts/third-party-notices.mjs';
const notices = await thirdPartyNotices();
const noticesPath = `assets/third-party-notices-${createHash('sha256').update(notices).digest('hex').slice(0,12)}.txt`;
function canonicalHtmlEntry(): Plugin {
  let outputDirectory = resolve('dist');
  return {
    name: 'canonical-html-entry', apply: 'build',
    configResolved(config) { outputDirectory = resolve(config.root, config.build.outDir); },
    async closeBundle() { await rename(resolve(outputDirectory, 'app.html'), resolve(outputDirectory, 'index.html')); }
  };
}
function scopedRuntimeWatch(): Plugin {
  return { name: 'ignore-project-runtime-state', apply: 'serve', configResolved(config) {
    if (config.server.watch === null) return;
    const previous = config.server.watch?.ignored, root = config.root.replace(/\\/g, '/').replace(/\/$/, '');
    config.server.watch = { ...config.server.watch, ignored: [...(previous === undefined ? [] : Array.isArray(previous) ? previous : [previous]), ...['work', '.tools', 'data', 'backups'].map(folder => `${root}/${folder}/**`)] };
  } };
}
export default defineConfig({
  define: { 'import.meta.env.VITE_NOTICES_URL': JSON.stringify('/'+noticesPath) },
  plugins: [react(), scopedRuntimeWatch(), { name: 'third-party-notices', apply: 'build', generateBundle() { this.emitFile({ type:'asset', fileName:noticesPath, source:notices }); } }, canonicalHtmlEntry()],
  server: { host: '127.0.0.1', port: Number(process.env.JIGE_DEV_PORT||5173), proxy: { '/api': `http://127.0.0.1:${process.env.PORT||8080}`, '/ws': { target: `ws://127.0.0.1:${process.env.PORT||8080}`, ws: true } } },
  build: { target: 'es2022', sourcemap: false, rollupOptions: { input: 'app.html' } }
});
