import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, expect, type Browser, type Page } from '@playwright/test';

// A component fixture exercises the real editor and rules data without touching
// a campaign or competing with production builds in the shared dist directory.
const fixtureSource = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CharacterEditor, LevelUpModal} from '/src/client/CharacterEditor.tsx';
import {entries} from '/src/content/index.ts';
import {createActor} from '/src/engine/actors.ts';
import '/src/client/styles.css';
const member={id:'fixture-member',name:'虚构验收成员',role:'gm'};
const legal={name:'虚构战士',ownerId:member.id,classes:[{classId:'class:fighter',level:1}],speciesId:'species:dwarf',backgroundId:'background:soldier',abilities:{str:17,dex:14,con:14,int:12,wis:10,cha:8},skills:['athletics','intimidation','perception','survival'],choices:{characterBuild:{method:'standard',baseAbilities:{str:15,dex:14,con:13,int:12,wis:10,cha:8},backgroundBonuses:{str:2,con:1}}}};
window.builderCalls=[];
function Fixture(){const query=new URLSearchParams(location.search);const[open,setOpen]=useState(true);const[saveError,setSaveError]=useState('');
 const save=async(data,draft)=>{window.builderCalls.push({data,draft});if(query.has('reject')&&window.builderCalls.length===1){setSaveError('服务器校验未通过：请核对该角色的规则来源。');return false;}return true;};
 const close=()=>setOpen(false);const actor=query.has('preset')?createActor({...legal,draft:true}):undefined;
 return open?query.get('mode')==='levelup'?<LevelUpModal actor={createActor({...legal,draft:false})} entries={entries} saveError={saveError} onSave={save} onClose={close}/>:<CharacterEditor actor={actor} actors={[]} entries={entries} members={[member]} member={member} saveError={saveError} onSave={save} onClose={close}/>:<p>保存完成</p>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
let server: ViteDevServer; let browser: Browser; let directory: string; let base: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jige-builder-ui-'));
  const virtualPath = '/__character_builder_fixture__.tsx'; const virtualId = resolve('__character_builder_fixture__.tsx').replaceAll('\\', '/');
  server = await createServer({ cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-character-builder-fixture',
    enforce: 'pre',
    resolveId(id) { if (id === virtualPath || id === virtualId) return virtualId; },
    load(id) { if (id === virtualId) return fixtureSource; },
    configureServer(instance) { instance.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/__builder_fixture__')) return next();
      const html = await instance.transformIndexHtml(request.url, `<html><body><div id="root"></div><script type="module" src="${virtualPath}"></script></body></html>`);
      response.setHeader('Content-Type', 'text/html'); response.end(html);
    }); },
  }] });
  await server.listen(); const address = server.httpServer!.address();
  assert.ok(address && typeof address === 'object'); base = `http://127.0.0.1:${address.port}/__builder_fixture__`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close(); await server?.close();
  if (directory) { const target = resolve(directory); if (target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('jige-builder-ui-')) await rm(target, { recursive: true, force: true }); }
});
async function pageFor(query = '', mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 960 } });
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(20_000);
  await page.goto(base + query); await expect(page.getByRole('dialog')).toBeVisible(); return page;
}
const calls = (page: Page) => page.evaluate(() => (window as any).builderCalls as { data: Record<string, any>; draft: boolean }[]);
test('checklist blocks incomplete creation, jumps to fields and accepts a valid build from any step', { timeout: 60_000 }, async () => {
  const page = await pageFor(); const dialog = page.getByRole('dialog'); const checklist = page.getByRole('region', { name: '创建前检查' });
  await expect(checklist).toContainText('还需完成');
  await dialog.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('建卡缺项'); assert.equal((await calls(page)).length, 0);
  await dialog.getByRole('button', { name: /下一步/ }).click();
  await expect(dialog.getByRole('tab', { name: /属性与熟练/ })).toHaveAttribute('aria-selected', 'true');
  await checklist.getByRole('button', { name: /请选择背景/ }).click();
  await expect(dialog.getByLabel('背景', { exact: true })).toBeFocused();
  await expect(dialog.getByLabel('子职', { exact: true })).toBeDisabled();
  await dialog.getByLabel('初始职业', { exact: true }).selectOption('class:wizard');
  await dialog.getByRole('spinbutton', { name: '等级', exact: true }).fill('3');
  await expect(dialog.getByLabel('子职', { exact: true }).locator('option')).toHaveCount(2);
  await checklist.getByRole('button', { name: /请为第 1 项职业选择子职/ }).click();
  await expect(dialog.getByLabel('子职', { exact: true })).toBeFocused();
  await dialog.getByLabel('子职', { exact: true }).selectOption('subclass:evoker');
  await dialog.getByRole('spinbutton', { name: '等级', exact: true }).fill('2');
  await expect(dialog.getByLabel('子职', { exact: true })).toBeDisabled(); await expect(dialog.getByLabel('子职', { exact: true })).toHaveValue('');
  await dialog.getByRole('textbox', { name: '角色名称', exact: true }).fill('完成选择的虚构战士');
  await dialog.getByLabel('物种', { exact: true }).selectOption('species:dwarf');
  await dialog.getByLabel('背景', { exact: true }).selectOption('background:soldier');
  await dialog.getByLabel('初始职业', { exact: true }).selectOption('class:fighter');
  await dialog.getByRole('spinbutton', { name: '等级', exact: true }).fill('1');
  await dialog.getByRole('button', { name: /下一步/ }).click();
  await dialog.getByLabel('力量背景提升', { exact: true }).selectOption('2'); await dialog.getByLabel('体质背景提升', { exact: true }).selectOption('1');
  await dialog.getByRole('checkbox', { name: '察觉', exact: true }).check(); await dialog.getByRole('checkbox', { name: '求生', exact: true }).check();
  await expect(checklist).toContainText('已通过当前建卡检查');
  await dialog.getByRole('button', { name: '创建角色', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const submitted = await calls(page); assert.equal(submitted.length, 1); assert.equal(submitted[0].draft, false); assert.equal(submitted[0].data.classes[0].subclassId, undefined);
  await page.close();
});
test('incomplete drafts remain saveable and capability labels are distinct from missing inputs', { timeout: 60_000 }, async () => {
  const page = await pageFor('', true); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '创建角色', exact: true }).click();
  const checklist = page.getByRole('region', { name: '创建前检查' });
  await expect(checklist).toBeInViewport(); await expect(checklist).toContainText(/还需完成 [1-9]/);
  await checklist.getByRole('button', { name: /请填写角色名称/ }).click();
  await expect(dialog.getByRole('textbox', { name: '角色名称', exact: true })).toBeFocused();
  assert.ok((await dialog.locator('.builder-fields').boundingBox())!.height > 100);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
  if (process.env.BUILDER_SCREENSHOT_DIR) { await mkdir(process.env.BUILDER_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.BUILDER_SCREENSHOT_DIR, 'builder-mobile-incomplete.png') }); }
  await dialog.getByRole('tab', { name: /装备与能力/ }).click();
  await expect(dialog.locator('.builder-capability').first()).toHaveAttribute('title', '这是能力执行方式，不是建卡缺项');
  await expect(dialog.locator('.builder-capability').filter({ hasText: '需要选择' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const submitted = await calls(page); assert.equal(submitted[0].draft, true); assert.equal(submitted[0].data.name, '未命名草稿');
  await page.close();
});
test('mobile editor keeps checklist, fields and server errors visible, then saves the corrected draft', { timeout: 60_000 }, async () => {
  const page = await pageFor('?preset=1&reject=1', true); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '验证并启用', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('服务器校验未通过'); await expect(dialog.getByRole('alert')).toBeInViewport();
  await dialog.getByRole('button', { name: /下一步/ }).click();
  await dialog.locator('.builder-fields').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const layout = await page.evaluate(() => {
    const error = document.querySelector('.builder-feedback')!.getBoundingClientRect(); const fields = document.querySelector('.builder-fields')!.getBoundingClientRect();
    const checklist = document.querySelector('.builder-checklist')!.getBoundingClientRect();
    return { errorVisible: error.top >= 0 && error.bottom <= innerHeight, fieldsHeight: fields.height, checklistVisible: checklist.top >= 0 && checklist.bottom <= innerHeight, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(layout.errorVisible, true); assert.equal(layout.checklistVisible, true); assert.ok(layout.fieldsHeight > 100); assert.ok(layout.overflow <= 1);
  if (process.env.BUILDER_SCREENSHOT_DIR) { await mkdir(process.env.BUILDER_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.BUILDER_SCREENSHOT_DIR, 'builder-mobile-error.png') }); }
  await dialog.getByRole('tab', { name: /故事与选择/ }).click();
  await dialog.getByRole('textbox', { name: '背景故事与角色笔记', exact: true }).fill('服务器拒绝后保留并修改的虚构笔记。');
  await dialog.getByRole('button', { name: '验证并启用', exact: true }).click(); await expect(dialog).toHaveCount(0);
  assert.equal((await calls(page))[1].data.notes, '服务器拒绝后保留并修改的虚构笔记。'); await page.close();
});
test('level-up rejection is visible inside the modal and can be corrected without losing the form', { timeout: 60_000 }, async () => {
  const page = await pageFor('?mode=levelup&reject=1'); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '升至下一级', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('服务器校验未通过'); await expect(dialog.getByRole('alert')).toBeInViewport();
  await dialog.getByRole('button', { name: '升至下一级', exact: true }).click(); await expect(dialog).toHaveCount(0);
  assert.equal((await calls(page)).length, 2); await page.close();
});
