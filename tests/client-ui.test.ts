import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { createActor, createGameState, resolveCommand } from '../src/engine/index';
import { entries, coverage } from '../src/content/index';
import type { Command, Snapshot } from '../src/shared/model';

let server: ChildProcess; let browser: Browser;
const base = 'http://127.0.0.1:5197';
before(async () => {
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5197', '--strictPort'], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_TEST_LEGACY_UI: '1' } });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const response = await fetch(`${base}/app.html`); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); server?.kill(); });

function fixture(): Snapshot {
  const state = createGameState('星落城纪事');
  state.actors = [createActor({ id: 'hero', name: '艾琳', ownerId: 'gm', classes: [{ classId: 'fighter', level: 1 }], speciesId: 'dwarf', backgroundId: 'soldier', abilities: { str: 17, dex: 14, con: 14, int: 12, wis: 10, cha: 8 }, skills: ['athletics', 'intimidation', 'perception', 'survival'], position: { x: 2, y: 2 }, draft: false }), createActor({ id: 'enemy', name: '训练守卫', ownerId: 'gm', kind: 'monster', hp: { current: 20, max: 20, temp: 0 }, baseAc: 10, position: { x: 3, y: 2 }, draft: false })];
  return { session: { campaignId: state.id, member: { id: 'gm', name: '主持人', role: 'gm' } }, state, members: [{ id: 'gm', name: '主持人', role: 'gm', online: true }], inviteCode: 'STARS42' };
}
async function setup(page: Page, options: { anonymous?: boolean; conflict?: boolean } = {}) {
  let snapshot = fixture(); const commands: Command[] = []; let authorized = !options.anonymous; let conflictOnce = Boolean(options.conflict);
  await page.routeWebSocket('**/ws', socket => { socket.send(JSON.stringify({ type: 'snapshot', snapshot })); });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const body = route.request().postDataJSON();
    if (url.pathname === '/api/content') return route.fulfill({ json: { entries, coverage } });
    if (url.pathname === '/api/join') { authorized = true; return route.fulfill({ json: { ...snapshot, recoveryCode: 'save-this-recovery-code' } }); }
    if (url.pathname === '/api/state') return route.fulfill({ status: authorized ? 200 : 401, json: authorized ? snapshot : { error: 'Not authenticated' } });
    if (url.pathname === '/api/command') {
      commands.push(body);
      if (conflictOnce) { conflictOnce = false; snapshot = { ...snapshot, state: { ...snapshot.state, rev: snapshot.state.rev + 1 } }; return route.fulfill({ status: 409, json: { error: 'State changed', code: 'stale_revision', snapshot } }); }
      try { const result = resolveCommand(snapshot.state, body, sides => sides); snapshot = { ...snapshot, state: { ...result.state, rev: snapshot.state.rev + 1 } }; return route.fulfill({ json: { snapshot, events: [] } }); }
      catch (reason) { return route.fulfill({ status: 422, json: { error: String(reason) } }); }
    }
    return route.fulfill({ json: {} });
  });
  return { commands, getSnapshot: () => snapshot };
}
test('desktop UI resolves a typed server action and requires explicit revision-conflict review', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { commands } = await setup(page, { conflict: true });
  await page.goto(`${base}/app.html`);
  await expect(page.getByRole('heading', { name: /星落城纪事/ })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('application', { name: /二维战术地图/ })).toBeVisible();
  if (process.env.CLIENT_SCREENSHOT_DIR) { await mkdir(process.env.CLIENT_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.CLIENT_SCREENSHOT_DIR, 'desktop.png'), fullPage: true }); }
  await page.getByRole('listbox', { name: /行动目标/ }).selectOption('enemy');
  await page.getByRole('button', { name: '优势', exact: true }).click();
  await page.getByRole('button', { name: /投掷并结算/ }).click();
  await expect(page.getByText('需要复核 · 艾琳')).toBeVisible();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].payload?.advantage, 1);
  assert.deepEqual(commands[0].targetIds, ['enemy']);
  await page.getByRole('button', { name: '按最新状态重提' }).click();
  await expect(page.locator('.pending-panel')).toHaveCount(0);
  assert.equal(commands.length, 2);
  assert.notEqual(commands[0].operationId, commands[1].operationId);
  assert.equal(commands[1].expectedRev, 1);
  await page.getByRole('button', { name: '规则图鉴', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索规则目录' }).fill('fireball');
  await expect(page.getByRole('heading', { name: '火球术', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  await page.close();
});
test('mobile join keeps a recovery code and all screens within the viewport', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await setup(page, { anonymous: true });
  await page.goto(`${base}/app.html?invite=STARS42`);
  await page.getByRole('textbox', { name: '怎么称呼你' }).fill('小鹿');
  await page.getByRole('button', { name: '加入冒险', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: '保存你的身份恢复码' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '' }).filter({ hasText: 'save-this-recovery-code' })).toHaveCount(1);
  page.on('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: '我已妥善保存' }).click();
  if (process.env.CLIENT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CLIENT_SCREENSHOT_DIR, 'mobile.png'), fullPage: true });
  for (const label of ['冒险桌', '角色', '规则图鉴', '旧卡迁移', '房间设置']) {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${label} overflows by ${overflow}px`);
  }
  await page.getByText('规则来源与许可', { exact: true }).click();
  await expect(page.getByText('中文界面与自动化为本项目改编。', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Creative Commons Attribution 4.0 International', exact: true })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/legalcode');
  await page.close();
});
test('character builder records base scores, background bonuses and class skills without raw JSON', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const { commands } = await setup(page);
  await page.goto(`${base}/app.html`);
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '角色名称' }).fill('灰岩');
  await dialog.getByLabel('物种', { exact: true }).selectOption('species:dwarf');
  await dialog.getByLabel('背景', { exact: true }).selectOption('background:soldier');
  await dialog.getByLabel('初始职业', { exact: true }).selectOption('class:fighter');
  await dialog.getByRole('tab', { name: /属性与熟练/ }).click();
  await dialog.getByLabel('力量背景提升', { exact: true }).selectOption('2');
  await dialog.getByLabel('体质背景提升', { exact: true }).selectOption('1');
  await dialog.getByRole('checkbox', { name: '察觉', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '求生', exact: true }).check();
  await dialog.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(commands[0].type, 'actor.create');
  assert.equal(commands[0].payload?.draft, false);
  const build = (commands[0].payload?.choices as any).characterBuild;
  assert.equal(build.method, 'standard');
  assert.deepEqual(build.backgroundBonuses, { str: 2, con: 1 });
  assert.equal((commands[0].payload?.abilities as any).str, 17);
  assert.ok((commands[0].payload?.skills as string[]).includes('athletics'));
  await page.close();
});
