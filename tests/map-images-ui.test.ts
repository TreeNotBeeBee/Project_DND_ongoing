import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { createApplication } from '../src/server/app.ts';
import type { Snapshot } from '../src/shared/model.ts';
const { PNG } = createRequire(import.meta.url)('pngjs');
let runtime: Awaited<ReturnType<typeof createApplication>>, browser: Browser, directory: string, base: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jige-map-images-'));
  const dist = join(directory, 'dist');
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: process.cwd(), windowsHide: true, stdio: 'pipe' });
  runtime = await createApplication({ dataDir: join(directory, 'data'), distDir: dist, hostToken: 'isolated-map-image-test' });
  const address = await runtime.listen(0); base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
});
after(async () => {
  await browser?.close(); await runtime?.close();
  if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('jige-map-images-')) await rm(directory, { recursive: true, force: true });
});
async function session() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(20000);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { (window as any).__imageCspViolations = []; document.addEventListener('securitypolicyviolation', event => (window as any).__imageCspViolations.push(event.violatedDirective)); });
  const opened = await context.request.post(base + '/api/campaigns', { headers: { Origin: base, 'X-Jige-Request': '1' }, data: { name: 'Image rendering proof', gmName: 'Image GM', hostToken: 'isolated-map-image-test' } });
  assert.equal(opened.status(), 201);
  const snapshot = async () => (await (await context.request.get(base + '/api/state')).json()) as Snapshot;
  const command = async (type: string, payload: Record<string, unknown>, actorId?: string) => {
    const result = await context.request.post(base + '/api/command', { headers: { Origin: base, 'X-Jige-Request': '1' }, data: { operationId: randomUUID(), expectedRev: (await snapshot()).state.rev, type, actorId, payload } });
    assert.equal(result.status(), 200, await result.text()); return (await result.json()).snapshot as Snapshot;
  };
  await command('scene.update', { scene: { ...(await snapshot()).state.scene, width: 16, height: 10 } });
  await command('actor.create', { monsterId: 'wolf', name: 'Image token', position: { x: 3, y: 2 } });
  const response = await page.goto(base + '/');
  const csp = response!.headers()['content-security-policy'];
  assert.match(csp, /img-src 'self' data: blob: https:/);
  assert.match(csp, /connect-src 'self' ws:\/\/localhost:\* ws:\/\/127\.0\.0\.1:\*/);
  assert.ok(!/worker-src[^;]*blob:/.test(csp), 'test must keep the production restriction on blob workers');
  await expect(page.locator('.battle-map canvas')).toBeVisible();
  const background = async (source: string) => { const current = await snapshot(); await command('scene.update', { scene: { ...current.state.scene, background: source } }); };
  return { context, page, errors, snapshot, command, background };
}
async function picture(page: Page, color: string, type: 'image/jpeg' | 'image/webp' | 'image/png' = 'image/png') {
  return page.evaluate(({ color, type }) => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32; const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 32); return canvas.toDataURL(type, .95); }, { color, type });
}
async function coloredPixels(page: Page, color: 'red' | 'blue' | 'green') {
  const { data } = PNG.sync.read(await page.locator('.battle-map canvas').screenshot()); let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (color === 'red' ? r > 150 && r > g * 2 && r > b * 2 : color === 'blue' ? b > 150 && b > r * 2 && b > g * 1.4 : g > 145 && g > r * 1.7 && g > b * 1.3) count++;
  }
  return count;
}
async function painted(page: Page, color: 'red' | 'blue' | 'green') { await expect.poll(() => coloredPixels(page, color), { timeout: 15000, message: `The actual production WebGL canvas must contain ${color} image pixels` }).toBeGreaterThan(10000); }
test('production CSP displays uploaded JPEG/WebP and HTTPS backgrounds, and clearing or late loads cannot resurrect an old map', { timeout: 90000 }, async () => {
  const f = await session();
  try {
    const red = await picture(f.page, '#f50c14', 'image/jpeg'), blue = await picture(f.page, '#0916f5', 'image/webp'), green = await picture(f.page, '#0beb15');
    for (const [source, type, name, color] of [[red, 'image/jpeg', 'map.jpg', 'red'], [blue, 'image/webp', 'map.webp', 'blue']] as const) {
      await f.page.getByRole('button', { name: '场景设置', exact: true }).click();
      await f.page.getByLabel('本地背景图片', { exact: true }).setInputFiles({ name, mimeType: type, buffer: Buffer.from(source.split(',')[1], 'base64') });
      await f.page.getByRole('button', { name: '保存场景', exact: true }).click();
      await expect.poll(async () => (await f.snapshot()).state.scene.background).toBe(source);
      await painted(f.page, color);
    }
    await f.context.route('https://images.example.test/without-extension', route => route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(green.split(',')[1], 'base64') }));
    await f.background('https://images.example.test/without-extension'); await painted(f.page, 'green');
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await f.context.route('https://images.example.test/slow-old.webp', async route => { started(); await held; await route.fulfill({ contentType: 'image/webp', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(blue.split(',')[1], 'base64') }).catch(() => {}); });
    await f.background('https://images.example.test/slow-old.webp'); await waiting;
    await f.background(red); await painted(f.page, 'red');
    await f.background(''); await expect.poll(() => coloredPixels(f.page, 'red')).toBeLessThan(30);
    const finished = f.page.waitForEvent('requestfinished', request => request.url().endsWith('slow-old.webp'));
    release(); await finished; await expect.poll(() => coloredPixels(f.page, 'blue')).toBeLessThan(30);
    await f.context.route('https://images.example.test/broken.jpg', route => route.fulfill({ status: 404, body: 'not an image' }));
    await f.background('https://images.example.test/broken.jpg'); await expect(f.page.getByRole('alert').filter({ hasText: '背景图片加载失败' })).toBeVisible();
    await f.background(green); await painted(f.page, 'green'); await expect(f.page.getByRole('alert').filter({ hasText: '背景图片加载失败' })).toHaveCount(0);
    assert.deepEqual(f.errors, []); assert.deepEqual(await f.page.evaluate(() => (window as any).__imageCspViolations), []);
  } finally { await f.context.close(); }
});
