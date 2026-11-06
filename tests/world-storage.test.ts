import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../src/server/database';
import { createActor, createGameState } from '../src/engine/index';
import { newWorld } from '../src/shared/world';
import { validateBackupState } from '../src/server/validation';

test('schema migration backs up the original and retains every legacy character for owner registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jige-world-migration-'));
  let storage: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    storage = await openDatabase(directory);
    const original = createGameState('原始世界');
    original.actors = [createActor({ id: 'legacy-one', ownerId: 'player', name: '原角色甲', draft: true }), createActor({ id: 'legacy-two', ownerId: 'player', name: '原角色乙', draft: true })];
    const db = storage.db;
    db.prepare('INSERT INTO campaigns(id,name,invite_code,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(original.id, original.name, 'migration-invite', JSON.stringify(original), 'before', 'before');
    db.prepare('INSERT INTO members(id,campaign_id,name,role,recovery_hash) VALUES(?,?,?,?,?)').run('owner', original.id, '原房主', 'gm', 'owner-hash');
    db.prepare('INSERT INTO members(id,campaign_id,name,role,recovery_hash) VALUES(?,?,?,?,?)').run('player', original.id, '原玩家', 'player', 'player-hash');
    db.pragma('user_version=1'); await storage.close(); storage = undefined;
    storage = await openDatabase(directory);
    assert.equal(storage.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    const migrated = JSON.parse((storage.db.prepare('SELECT state FROM campaigns WHERE id=?').get(original.id) as any).state);
    assert.equal(migrated.world.ownerId, 'owner'); assert.equal(migrated.world.mode, 'gm');
    assert.deepEqual(migrated.actors.map((a: any) => a.id), ['legacy-one', 'legacy-two']);
    assert.ok(migrated.actors.every((a: any) => a.registration === 'requested' && a.requestedBy === 'player'));
    assert.deepEqual(migrated.actors.map((a: any) => a.hp), original.actors.map(a => a.hp));
    const manifests = (await readdir(join(directory, 'backups'))).filter(f => f.endsWith('.manifest.json'));
    assert.equal(manifests.length, 1);
    const manifest = JSON.parse(await readFile(join(directory, 'backups', manifests[0]), 'utf8'));
    assert.equal(manifest.schemaVersion, 1); assert.ok(manifest.backupId); assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(storage.db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    await storage?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('jige-world-migration-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('backups retain free values, governance and drafts, while malformed standard cards still fail validation', () => {
  const state = createGameState('自由备份'); state.world = newWorld('owner', 'co-create', { system: 'dictatorship' });
  state.world.drafts.push({ id: 'draft', ownerId: 'player', title: '只写了一半', kind: 'rules', payload: { half: true }, updatedAt: 1 });
  state.actors.push(createActor({ profile: 'free', abilities: { str: 100, dex: -4 } as any, story: '故事', ownerId: 'owner' }));
  const restored = validateBackupState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.actors[0].abilities.str, 100); assert.equal(restored.actors[0].abilities.dex, -4);
  assert.equal(restored.world!.governance.system, 'dictatorship'); assert.equal(restored.world!.drafts[0].payload.half, true);
  const invalid = structuredClone(state); delete invalid.actors[0].profile;
  assert.throws(() => validateBackupState(invalid), /标准角色属性/);
});
