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
async function session(fallback = false) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(20000);
  const page = await context.newPage(), errors: string[] = [];
  if (fallback) await page.addInitScript(() => { (window as any).__forceMapImageFallback = true; for (const prototype of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype].filter(Boolean)) { const original = prototype.getContext; (prototype as any).getContext = function (type: string, ...args: any[]) { return (window as any).__forceMapImageFallback ? null : (original as any).apply(this, [type, ...args]); }; } Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }); });
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
  await expect(page.locator(fallback ? '.battle-map svg.map-fallback' : '.battle-map canvas')).toBeVisible();
  if (fallback) await page.evaluate(() => { (window as any).__forceMapImageFallback = false; });
  const background = async (source: string) => { const current = await snapshot(); await command('scene.update', { scene: { ...current.state.scene, background: source } }); };
  return { context, page, errors, snapshot, command, background };
}
async function picture(page: Page, color: string, type: 'image/jpeg' | 'image/webp' | 'image/png' = 'image/png') {
  return page.evaluate(({ color, type }) => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32; const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 32); return canvas.toDataURL(type, .95); }, { color, type });
}
async function coloredPixels(page: Page, color: 'red' | 'blue' | 'green') {
  const { data } = PNG.sync.read(await page.locator('.battle-map canvas, .battle-map svg.map-fallback').screenshot()); let count = 0;
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
async function circleProof(page: Page) {
  const { data, width, height } = PNG.sync.read(await page.locator('.battle-map canvas, .battle-map svg.map-fallback').screenshot());
  const green = (x: number, y: number) => { const i = (y * width + x) * 4; return data[i + 1] > 145 && data[i + 1] > data[i] * 1.7 && data[i + 1] > data[i + 2] * 1.3; };
  let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (green(x, y)) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++; }
  assert.ok(count > 250, 'portrait must paint actual pixels inside the token');
  assert.ok(Math.abs((maxX - minX) - (maxY - minY)) < 3, 'portrait must be cropped to a square circle, not stretched to the original aspect');
  assert.ok(!green(minX + 1, minY + 1) && !green(maxX - 1, minY + 1) && !green(minX + 1, maxY - 1) && !green(maxX - 1, maxY - 1), 'portrait rectangle corners must be clipped out');
  let selectedRing = 0, name = 0, hp = 0;
  for (let y = Math.max(0, minY - 8); y < Math.min(height, maxY + 30); y++) for (let x = Math.max(0, minX - 20); x < Math.min(width, maxX + 20); x++) {
    const i = (y * width + x) * 4, [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (y < minY && r > 210 && g > 195 && b > 150) selectedRing++;
    if (y > maxY + 7 && r > 120 && g > 120 && b > 120) name++;
    if (y > maxY + 20 && g > 140 && g > r && b > 100) hp++;
  }
  assert.ok(selectedRing > 2, 'selected ownership/token border must stay outside the portrait');
  assert.ok(name > 3 && hp > 3, 'token name and HP must remain visibly painted');
}
for (const fallback of [false, true]) test(`production ${fallback ? 'SVG fallback' : 'Pixi'} paints circular uploaded portraits, retains placeholders, and never requests hidden portraits for a player`, { timeout: 90000 }, async () => {
  const f = await session(fallback);
  try {
    const actor = (await f.snapshot()).state.actors[0];
    const baseline = { red: await coloredPixels(f.page, 'red'), blue: await coloredPixels(f.page, 'blue'), green: await coloredPixels(f.page, 'green') };
    // Exercise the existing 256px WebP upload path, rather than inventing another avatar format.
    const upload = await picture(f.page, '#0beb15', 'image/png');
    await f.page.locator('.monster-row').filter({ hasText: 'Image token' }).dblclick();
    await f.page.getByRole('button', { name: '编辑', exact: true }).click();
    await f.page.getByRole('tab', { name: '05故事与选择' }).click();
    await f.page.getByLabel('上传头像', { exact: true }).setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(upload.split(',')[1], 'base64') });
    await expect(f.page.getByLabel('头像地址', { exact: true })).toHaveValue(/^data:image\/webp;/);
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).state.actors[0].portrait).toMatch(/^data:image\/webp;/);
    await expect.poll(() => coloredPixels(f.page, 'green')).toBeGreaterThan(250);
    await circleProof(f.page);
    const blue = await picture(f.page, '#0916f5', 'image/webp'), red = await picture(f.page, '#f50c14', 'image/jpeg');
    await f.context.route('https://images.example.test/broken-portrait.jpg', route => route.fulfill({ status: 404, body: 'missing portrait' }));
    await f.command('actor.update', { patch: { portrait: 'https://images.example.test/broken-portrait.jpg' } }, actor.id);
    await expect.poll(() => coloredPixels(f.page, 'green')).toBeLessThan(baseline.green + 10);
    await expect(f.page.getByRole('status').filter({ hasText: '部分角色头像加载失败' })).toBeVisible();
    // Failed portraits keep the actual painted text token, not an invisible/missing actor.
    await expect(f.page.locator('.monster-row').filter({ hasText: 'Image token' })).toBeVisible();
    await f.command('actor.update', { patch: { portrait: blue } }, actor.id);
    await expect.poll(() => coloredPixels(f.page, 'blue')).toBeGreaterThan(250);
    await expect(f.page.getByRole('status').filter({ hasText: '部分角色头像加载失败' })).toHaveCount(0);
    await f.command('actor.update', { patch: { portrait: '' } }, actor.id);
    await expect.poll(() => coloredPixels(f.page, 'blue')).toBeLessThan(baseline.blue + 10);
    const { data } = PNG.sync.read(await f.page.locator('.battle-map canvas, .battle-map svg.map-fallback').screenshot());
    let placeholder = 0; for (let i = 0; i < data.length; i += 4) if (data[i] === 83 && data[i + 1] === 61 && data[i + 2] === 67) placeholder++;
    assert.ok(placeholder > 100, 'a cleared avatar must retain the painted monster placeholder');
    if (fallback) {
      await f.background(red); await painted(f.page, 'red');
      await f.background(blue); await painted(f.page, 'blue');
      await f.background(''); await expect.poll(() => coloredPixels(f.page, 'red')).toBeLessThan(baseline.red + 10);
    }
    await f.command('actor.update', { patch: { portrait: blue } }, actor.id);
    const hidden = await f.command('actor.create', { monsterId: 'wolf', name: 'Hidden portrait', hidden: true, position: { x: 8, y: 3 } });
    const secret = hidden.state.actors.find(row => row.name === 'Hidden portrait')!;
    const secretUrl = 'https://images.example.test/hidden-secret.webp';
    await f.context.route(secretUrl, route => route.fulfill({ contentType: 'image/webp', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(blue.split(',')[1], 'base64') }));
    await f.command('actor.update', { patch: { portrait: secretUrl } }, secret.id);
    const player = await browser.newContext({ viewport: { width: 1600, height: 1100 } }); let secretRequests = 0;
    try {
      await player.route(secretUrl, route => { secretRequests++; return route.fulfill({ contentType: 'image/webp', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(blue.split(',')[1], 'base64') }); });
      const joined = await player.request.post(base + '/api/join', { headers: { Origin: base, 'X-Jige-Request': '1' }, data: { inviteCode: (await f.snapshot()).inviteCode, name: 'Image player' } }); assert.equal(joined.status(), 200);
      const visible = await (await player.request.get(base + '/api/state')).json();
      assert.ok(!JSON.stringify(visible).includes(secretUrl));
      const page = await player.newPage();
      if (fallback) await page.addInitScript(() => { (window as any).__forceMapImageFallback = true; for (const prototype of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype].filter(Boolean)) { const original = prototype.getContext; (prototype as any).getContext = function (type: string, ...args: any[]) { return (window as any).__forceMapImageFallback ? null : (original as any).apply(this, [type, ...args]); }; } Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }); });
      await page.goto(base + '/'); if (fallback) { await expect(page.locator('.map-fallback')).toBeVisible(); await page.evaluate(() => { (window as any).__forceMapImageFallback = false; }); } await expect.poll(() => coloredPixels(page, 'blue')).toBeGreaterThan(250);
      assert.equal(secretRequests, 0, 'server-hidden actor images must not be prefetched by the player map or roster');
    } finally { await player.close(); }
    assert.deepEqual(f.errors, []); assert.deepEqual(await f.page.evaluate(() => (window as any).__imageCspViolations), []);
  } finally { await f.context.close(); }
});
