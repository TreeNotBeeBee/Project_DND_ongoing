import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('development watcher ignores checkout/data changes while ordinary source files still emit changes', async t => {
  const owned = await mkdtemp(join(tmpdir(), 'jige-watch-')), directory = join(owned, 'work', 'checkout');
  await mkdir(directory, { recursive: true });
  const control = join(directory, 'source.txt'); await writeFile(control, 'before');
  await writeFile(join(directory, 'app.html'), '<main>Watcher test</main>');
  const server = await createServer({ root: directory, configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  t.after(async () => { await server.close(); assert.ok(resolve(owned).startsWith(resolve(tmpdir()) + sep) && basename(owned).startsWith('jige-watch-')); await rm(owned, { recursive: true, force: true }); });
  const events: string[] = []; server.watcher.on('all', (_, path) => events.push(resolve(path)));
  await server.listen(); await new Promise(ok => setTimeout(ok, 300));
  for (const folder of ['work', '.tools', 'data', 'backups']) {
    await mkdir(join(directory, folder, 'qa'), { recursive: true });
    await writeFile(join(directory, folder, 'qa', 'app.html'), '<main>Ignore</main>');
    await writeFile(join(directory, folder, 'qa', 'tsconfig.json'), '{}');
  }
  await writeFile(control, 'after');
  const deadline = Date.now() + 4000;
  while (!events.includes(resolve(control)) && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 50));
  assert.ok(events.includes(resolve(control)), 'ordinary file changes must remain watched');
  await new Promise(ok => setTimeout(ok, 150));
  for (const folder of ['work', '.tools', 'data', 'backups']) assert.equal(events.some(path => path.startsWith(resolve(directory, folder) + sep)), false, folder + ' must not cause reloads');
});
