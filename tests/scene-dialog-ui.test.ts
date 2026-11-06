import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect, type Browser } from '@playwright/test';
import { createApplication } from '../src/server/app';

let directory: string, base: string, browser: Browser;
let runtime: Awaited<ReturnType<typeof createApplication>>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jige-scene-dialog-'));
  const dist = join(directory, 'web');
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist], { env: { ...process.env, VITE_TEST_LEGACY_UI: '1' }, windowsHide: true, stdio: 'ignore', timeout: 120_000 });
  runtime = await createApplication({ dataDir: join(directory, 'data'), distDir: dist, hostToken: 'scene-ui-test-only' });
  base = `http://127.0.0.1:${(await runtime.listen(0)).port}`;
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
});
after(async () => {
  await browser?.close(); await runtime?.close();
  if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('jige-scene-dialog-')) await rm(directory, { recursive: true, force: true });
});

for (const mobile of [false, true]) test(`scene image feedback and server errors stay visible on ${mobile ? 'mobile' : 'desktop'}`, { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile });
  context.setDefaultTimeout(15_000);
  try {
    const created = await context.request.post(`${base}/api/campaigns`, { headers: { Origin: base, 'X-Jige-Request': '1' }, data: { hostToken: 'scene-ui-test-only', name: '场景上传验收', gmName: '测试主持人' } });
    assert.equal(created.status(), 201);
    const page = await context.newPage(); await page.goto(base);
    const open = () => page.getByRole('button', { name: '场景设置', exact: true }).click();
    await open();
    const dialog = page.getByRole('dialog'), upload = dialog.getByLabel('本地背景图片', { exact: true }), save = dialog.getByRole('button', { name: '保存场景', exact: true });
    await upload.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture') });
    await expect(dialog.getByRole('alert')).toContainText('图片无法加载');
    await expect(save).toBeDisabled();
    const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32; canvas.getContext('2d')!.fillRect(0, 0, 64, 32); return canvas.toDataURL('image/webp'); });
    const file = { name: 'map.webp', mimeType: 'image/webp', buffer: Buffer.from(image.split(',')[1], 'base64') };
    await upload.setInputFiles(file);
    await expect(dialog.getByRole('img', { name: '背景地图预览' })).toBeVisible();
    await expect(save).toBeEnabled();
    await expect(dialog.getByText(/map.webp · 预览已就绪/)).toBeVisible();
    await upload.setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await expect(dialog.getByRole('alert')).toContainText('4MB');
    await expect(save).toBeDisabled();
    // Selecting the same valid image again must finish decoding and release Save.
    await upload.setInputFiles(file); await expect(save).toBeEnabled();
    await save.click(); await expect(dialog).toHaveCount(0);
    assert.equal((await (await context.request.get(`${base}/api/state`)).json()).state.scene.background, image);
    await open(); await expect(save).toBeEnabled();
    await dialog.getByRole('button', { name: '清除背景', exact: true }).click();
    await save.click(); await expect(dialog).toHaveCount(0);
    assert.equal((await (await context.request.get(`${base}/api/state`)).json()).state.scene.background, undefined);
    await open();
    await page.route('**/api/command', route => route.fulfill({ status: 400, json: { error: '测试：场景暂时不能保存', code: 'rules' } }), { times: 1 });
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('测试：场景暂时不能保存');
    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const error = await dialog.getByRole('alert').boundingBox(), box = await dialog.boundingBox();
    assert.ok(error && box && error.y >= box.y && error.y + error.height <= box.y + box.height, 'server error remains inside the visible modal while scrolled');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  } finally { await context.close(); }
});

test('separate GM and player sessions show their identity, creation access and different scene permissions', { timeout: 60_000 }, async () => {
  const gm = await browser.newContext(), player = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  gm.setDefaultTimeout(15_000); player.setDefaultTimeout(15_000);
  try {
    const created = await gm.request.post(`${base}/api/campaigns`, { headers: { Origin: base, 'X-Jige-Request': '1' }, data: { hostToken: 'scene-ui-test-only', name: '身份验收', gmName: '测试主持人' } });
    assert.equal(created.status(), 201);
    const joined = await player.request.post(`${base}/api/join`, { headers: { Origin: base, 'X-Jige-Request': '1' }, data: { inviteCode: (await created.json()).inviteCode, name: '测试玩家' } });
    assert.equal(joined.status(), 200);
    const gmPage = await gm.newPage(), playerPage = await player.newPage();
    await Promise.all([gmPage.goto(base), playerPage.goto(base)]);
    await expect(gmPage.locator('.identity-badge')).toHaveText('主持人');
    await expect(playerPage.locator('.identity-badge')).toHaveText('玩家');
    await expect(gmPage.getByRole('button', { name: '场景设置', exact: true })).toBeVisible();
    await expect(playerPage.getByRole('button', { name: '场景设置', exact: true })).toHaveCount(0);
    await expect(gmPage.getByRole('button', { name: '创建角色', exact: true })).toBeVisible();
    await expect(playerPage.getByRole('button', { name: '创建角色', exact: true })).toBeVisible();
    await gmPage.getByRole('button', { name: '邀请伙伴', exact: true }).click();
    await expect(gmPage.getByRole('dialog').getByText(/普通标签页会共享当前主持人身份/)).toBeVisible();
    await gmPage.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    for (const page of [gmPage, playerPage]) {
      await page.getByRole('button', { name: '房间设置', exact: true }).click();
      await expect(page.getByRole('heading', { name: '你的身份与权限' })).toBeVisible();
      await expect(page.getByText(/要同时体验玩家视角/)).toBeVisible();
    }
    assert.notEqual((await (await gm.request.get(`${base}/api/state`)).json()).session.member.id, (await (await player.request.get(`${base}/api/state`)).json()).session.member.id);
  } finally { await Promise.all([gm.close(), player.close()]); }
});

test('a real revision conflict can be reviewed inside the open mobile dialog without losing the form', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  context.setDefaultTimeout(15_000);
  try {
    const headers = { Origin: base, 'X-Jige-Request': '1' };
    assert.equal((await context.request.post(`${base}/api/campaigns`, { headers, data: { hostToken: 'scene-ui-test-only', name: '场景冲突验收', gmName: '测试主持人' } })).status(), 201);
    const page = await context.newPage(); await page.goto(base);
    await page.getByRole('button', { name: '场景设置', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('宽度（格）', { exact: true }).fill('25');
    const interleaveChange = () => page.route('**/api/command', async route => {
      const state = (await (await context.request.get(`${base}/api/state`)).json()).state;
      const changed = await context.request.post(`${base}/api/command`, { headers, data: { operationId: randomUUID(), expectedRev: state.rev, type: 'scene.update', payload: { scene: { ...state.scene, fog: !state.scene.fog } } } });
      assert.equal(changed.status(), 200); await route.continue();
    }, { times: 1 });
    await interleaveChange();
    await dialog.getByRole('button', { name: '保存场景', exact: true }).click();
    await expect(dialog.locator('.pending-panel')).toContainText('需要复核');
    await expect(dialog.getByRole('button', { name: '按最新状态重提', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '放弃此操作', exact: true }).click();
    await expect(dialog.locator('.pending-panel')).toHaveCount(0);
    await expect(dialog.getByLabel('宽度（格）', { exact: true })).toHaveValue('25');
    await dialog.getByRole('button', { name: '保存场景', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const final = (await (await context.request.get(`${base}/api/state`)).json()).state;
    assert.equal(final.rev, 2); assert.equal(final.scene.width, 25);
    await page.getByRole('button', { name: '场景设置', exact: true }).click();
    await dialog.getByLabel('宽度（格）', { exact: true }).fill('21');
    await interleaveChange();
    await dialog.getByRole('button', { name: '保存场景', exact: true }).click();
    await expect(dialog.locator('.pending-panel')).toContainText('需要复核');
    await dialog.getByRole('button', { name: '按最新状态重提', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const retried = (await (await context.request.get(`${base}/api/state`)).json()).state;
    assert.equal(retried.rev, 4); assert.equal(retried.scene.width, 21);
  } finally { await context.close(); }
});

test('character-sheet and builder rejections stay inside the modal and a corrected card can be saved', { timeout: 90_000 }, async () => {
  const context = await browser.newContext(); context.setDefaultTimeout(15_000);
  try {
    const headers = { Origin: base, 'X-Jige-Request': '1' };
    assert.equal((await context.request.post(`${base}/api/campaigns`, { headers, data: { hostToken: 'scene-ui-test-only', name: '角色卡提示验收', gmName: '测试主持人' } })).status(), 201);
    const state = async () => (await (await context.request.get(`${base}/api/state`)).json()).state;
    const command = async (type: string, payload: object, actorId?: string) => {
      const result = await context.request.post(`${base}/api/command`, { headers, data: { operationId: randomUUID(), expectedRev: (await state()).rev, type, payload, actorId } });
      assert.equal(result.status(), 200);
    };
    await command('actor.create', { monsterId: 'wolf', name: '背包验收' });
    const actorId = (await state()).actors[0].id;
    await command('inventory.add', { contentId: 'equipment:longsword', quantity: 1 }, actorId);
    const page = await context.newPage(); await page.goto(base);
    await page.getByRole('button', { name: '打开完整角色卡', exact: true }).click();
    await page.getByRole('button', { name: '背包与装备', exact: true }).click();
    await page.route('**/api/command', route => route.fulfill({ status: 400, json: { error: '测试：这件物品暂不能穿戴', code: 'rules' } }), { times: 1 });
    const dialog = page.getByRole('dialog');
    await dialog.locator('.inventory-row').getByRole('button', { name: '穿戴', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('这件物品暂不能穿戴');
    await expect(dialog.locator('.pending-panel')).toHaveCount(0);
    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const alert = await dialog.getByRole('alert').boundingBox(), bounds = await dialog.boundingBox();
    assert.ok(alert && bounds && alert.y >= bounds.y && alert.y + alert.height <= bounds.y + bounds.height);
    assert.equal((await state()).actors[0].inventory[0].equipped, false);
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '创建角色', exact: true }).click();
    await dialog.getByLabel('角色名称', { exact: true }).fill('新旅者');
    await dialog.getByLabel('物种', { exact: true }).selectOption('species:dwarf');
    await dialog.getByLabel('背景', { exact: true }).selectOption('background:soldier');
    await dialog.getByLabel('初始职业', { exact: true }).selectOption('class:fighter');
    await dialog.getByRole('tab', { name: /属性与熟练/ }).click();
    await dialog.getByLabel('力量背景提升', { exact: true }).selectOption('2');
    await dialog.getByLabel('体质背景提升', { exact: true }).selectOption('1');
    await dialog.getByRole('checkbox', { name: '察觉', exact: true }).check();
    await dialog.getByRole('checkbox', { name: '求生', exact: true }).check();
    await page.route('**/api/command', route => route.fulfill({ status: 400, json: { error: '测试：角色暂不能保存', code: 'rules' } }), { times: 1 });
    await dialog.getByRole('button', { name: '创建角色', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('角色暂不能保存');
    await expect(dialog.locator('.pending-panel')).toHaveCount(0);
    assert.equal((await state()).actors.length, 1);
    await dialog.getByRole('tab', { name: /身份与职业/ }).click();
    await dialog.getByLabel('角色名称', { exact: true }).fill('重新提交的旅者');
    await dialog.getByRole('button', { name: '创建角色', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = await state();
    assert.equal(saved.actors.length, 2);
    assert.ok(saved.actors.some((actor: { name: string }) => actor.name === '重新提交的旅者'));
  } finally { await context.close(); }
});
