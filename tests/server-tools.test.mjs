import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { extractTunnelUrl,parseArguments } from '../scripts/host.mjs';
import { openDatabase,acquireDataLock,codeCommit,SCHEMA_VERSION } from '../src/server/database.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function run(script,args,env){return new Promise((ok,no)=>{const child=spawn(process.execPath,[resolve(root,'scripts',script),...args],{cwd:root,windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',no);child.on('exit',code=>ok({code,stdout,stderr}));});}
test('host flags and exact generated tunnel URL parsing',()=>{
  assert.deepEqual(parseArguments(['--local','--no-open','--port','8123','--data-dir','data']),{local:true,noOpen:true,port:8123,dataDir:resolve('data')});assert.throws(()=>parseArguments(['--port','-1']));assert.throws(()=>parseArguments(['--data-dir']));assert.throws(()=>parseArguments(['--unknown']));
  assert.equal(extractTunnelUrl('INF Visit https://one-two.trycloudflare.com now'),'https://one-two.trycloudflare.com');assert.equal(extractTunnelUrl('https://evil.example'),null);
});
test('data directory lock refuses a second live owner',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jige-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));const release=await acquireDataLock(dir);await assert.rejects(()=>acquireDataLock(dir),/已有主机/);await release();const second=await acquireDataLock(dir);await second();
});
test('CLI online backup, stopped-host restore and restore lock protection',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jige-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));const dataDir=join(dir,'data');const initial=await openDatabase(dataDir);const originalServerId=initial.serverId;initial.db.prepare("INSERT INTO metadata(key,value) VALUES ('marker','original')").run();
  const backup=await run('backup.mjs',[join(dir,'copies')],{JIGE_DATA_DIR:dataDir});assert.equal(backup.code,0,backup.stderr);const path=backup.stdout.trim().split('：').slice(1).join('：');const manifest=JSON.parse(await readFile(path+'.manifest.json','utf8'));assert.equal(manifest.serverId,originalServerId);assert.equal(manifest.schemaVersion,SCHEMA_VERSION);assert.match(manifest.sha256,/^[a-f0-9]{64}$/);assert.equal(manifest.gitCommit,codeCommit());assert.match(manifest.gitCommit,/^(?:[a-f0-9]{7,64}|unversioned)$/);assert.ok(manifest.backupId);
  const blocked=await run('restore.mjs',[path],{JIGE_DATA_DIR:dataDir});assert.notEqual(blocked.code,0);assert.match(blocked.stderr,/已有主机/);await initial.close();
  const changed=new Database(join(dataDir,'game.sqlite'));changed.prepare("UPDATE metadata SET value='changed' WHERE key='marker'").run();changed.close();
  const restored=await run('restore.mjs',[path],{JIGE_DATA_DIR:dataDir});assert.equal(restored.code,0,restored.stderr);const verify=new Database(join(dataDir,'game.sqlite'),{readonly:true});try{assert.equal(verify.prepare("SELECT value FROM metadata WHERE key='marker'").get().value,'original');assert.equal(verify.prepare("SELECT value FROM metadata WHERE key='serverId'").get().value,originalServerId);}finally{verify.close();}
  await appendFile(path,'tampered');const rejected=await run('restore.mjs',[path],{JIGE_DATA_DIR:dataDir});assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/SHA256/);
});
