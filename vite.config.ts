import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { thirdPartyNotices } from './scripts/third-party-notices.mjs';
const notices = await thirdPartyNotices();
const noticesPath = `assets/third-party-notices-${createHash('sha256').update(notices).digest('hex').slice(0,12)}.txt`;
export default defineConfig({
  define: { 'import.meta.env.VITE_NOTICES_URL': JSON.stringify('/'+noticesPath) },
  plugins: [react(), { name: 'third-party-notices', apply: 'build', generateBundle() { this.emitFile({ type:'asset', fileName:noticesPath, source:notices }); } }, { name: 'canonical-html-entry', apply: 'build', async closeBundle() {
    await rename(resolve('dist/app.html'), resolve('dist/index.html'));
  } }],
  server: { host: '127.0.0.1', port: Number(process.env.JIGE_DEV_PORT||5173), proxy: { '/api': `http://127.0.0.1:${process.env.PORT||8080}`, '/ws': { target: `ws://127.0.0.1:${process.env.PORT||8080}`, ws: true } } },
  build: { target: 'es2022', sourcemap: false, rollupOptions: { input: 'app.html' } }
});
