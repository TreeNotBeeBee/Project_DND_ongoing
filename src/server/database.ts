import Database from 'better-sqlite3';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, open } from 'node:fs/promises';
import { existsSync,createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { newWorld } from '../shared/world';

export const SCHEMA_VERSION = 3;
export const CODE_VERSION = '2.0.0-beta.2';
export type GameDatabase = Database.Database;

export function codeCommit() {
  if(process.env.JIGE_CODE_COMMIT&&/^[a-f0-9]{7,64}$/i.test(process.env.JIGE_CODE_COMMIT))return process.env.JIGE_CODE_COMMIT;
  try{return execFileSync('git',['-C',fileURLToPath(new URL('../..',import.meta.url)),'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();}catch{return 'unversioned';}
}
export async function sha256File(path:string){const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}

export async function onlineBackup(db: GameDatabase, directory: string, label = 'manual') {
  await mkdir(directory, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}-${randomUUID().slice(0, 8)}.sqlite`;
  const path = join(directory, filename);
  await db.backup(path);
  const check = new Database(path, { readonly: true });
  try {
    if (check.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('备份完整性校验失败');
    const serverId = (check.prepare("SELECT value FROM metadata WHERE key='serverId'").get() as any)?.value;
    const databaseGitCommit = (check.prepare("SELECT value FROM metadata WHERE key='gitCommit'").get() as any)?.value;
    const databaseCodeVersion = (check.prepare("SELECT value FROM metadata WHERE key='codeVersion'").get() as any)?.value;
    await writeFile(`${path}.manifest.json`, JSON.stringify({ format: 'jigerpg-database', backupId:randomUUID(),sha256:await sha256File(path),gitCommit:codeCommit(), schemaVersion: check.pragma('user_version', { simple: true }), codeVersion: CODE_VERSION, databaseGitCommit, databaseCodeVersion, serverId, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  } finally { check.close(); }
  return path;
}

export async function acquireDataLock(directory: string) {
  const path = join(directory, '.server.lock');
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => { try { const value = JSON.parse(await readFile(path, 'utf8')); if (value.pid === process.pid) await unlink(path); } catch { /* already released */ } };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let previous: any;
      try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('数据目录锁损坏，请先确认没有主机进程再移除 .server.lock'); }
      try { process.kill(previous.pid, 0); throw new Error('该数据目录已有主机进程在运行'); }
      catch (probe: any) { if (probe.code !== 'ESRCH') throw probe; }
      await unlink(path);
    }
  }
  throw new Error('无法取得数据目录锁');
}

export async function openDatabase(dataDirectory: string, lock = true) {
  const dataDir = resolve(dataDirectory);
  await mkdir(dataDir, { recursive: true });
  const release = lock ? await acquireDataLock(dataDir) : async () => {};
  let db: GameDatabase | undefined;
  try {
    const path = join(dataDir, 'game.sqlite');
    const existing = existsSync(path);
    db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version > SCHEMA_VERSION) throw new Error(`数据库版本 ${version} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级程序或恢复兼容备份`);
    if (existing && version < SCHEMA_VERSION && db.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata'").get()) await onlineBackup(db, join(dataDir, 'backups'), 'before-migration');
    db.transaction(() => {
      db!.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, code_version TEXT NOT NULL, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, event_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('gm','player')), recovery_hash TEXT NOT NULL UNIQUE);
        CREATE UNIQUE INDEX IF NOT EXISTS one_gm_per_campaign ON members(campaign_id) WHERE role='gm';
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, member_id TEXT NOT NULL, operation_id TEXT NOT NULL, command_type TEXT NOT NULL, command_json TEXT NOT NULL, before_state TEXT NOT NULL, events TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY(campaign_id,member_id,operation_id));
        CREATE TABLE IF NOT EXISTS migrations (campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, member_id TEXT NOT NULL, report TEXT NOT NULL, PRIMARY KEY(campaign_id,fingerprint));
        CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL, UNIQUE(campaign_id,owner_id,sha256));
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, can_host INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS account_members (member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, UNIQUE(account_id,campaign_id));
        CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
      `);
      if (!db!.prepare('PRAGMA table_info(campaigns)').all().some((column: any) => column.name === 'account_required')) db!.exec('ALTER TABLE campaigns ADD COLUMN account_required INTEGER NOT NULL DEFAULT 0');
      if (version < 2) {
        const update = db!.prepare('UPDATE campaigns SET state=? WHERE id=?');
        for (const row of db!.prepare('SELECT id,state FROM campaigns').all() as { id: string; state: string }[]) {
          const state = JSON.parse(row.state);
          const owner = db!.prepare("SELECT id FROM members WHERE campaign_id=? AND role='gm'").get(row.id) as { id: string } | undefined;
          if (!state.world && owner) {
            state.world = newWorld(owner.id, 'gm');
            for (const actor of state.actors || []) if (actor.kind === 'hero') {
              actor.registration = 'requested'; actor.requestedBy = actor.ownerId; actor.hidden = true;
              actor.publicGroups ||= []; actor.knownEntries ||= [];
            }
            update.run(JSON.stringify(state), row.id);
          }
        }
      }
      db!.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('serverId', randomUUID());
      db!.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run('codeVersion', CODE_VERSION);
      db!.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run('gitCommit', codeCommit());
      db!.prepare('INSERT OR IGNORE INTO schema_migrations(version,code_version,applied_at) VALUES (?,?,?)').run(SCHEMA_VERSION, CODE_VERSION, new Date().toISOString());
      db!.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    const serverId = (db.prepare("SELECT value FROM metadata WHERE key='serverId'").get() as any).value as string;
    const ready = db;
    return { db: ready, dataDir, path, serverId, close: async () => { try { ready.pragma('wal_checkpoint(TRUNCATE)'); ready.close(); } finally { await release(); } } };
  } catch (error) { db?.close(); await release(); throw error; }
}
