import { register } from 'tsx/esm/api';
import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir,rename,unlink,readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function restore(source=process.argv[2]){
  if(!source)throw new Error('用法：npm run restore -- <备份.sqlite>；请先关闭主机');
  register();const{acquireDataLock,onlineBackup,sha256File,SCHEMA_VERSION}=await import('../src/server/database.ts');
  const dataDir=resolve(process.env.JIGE_DATA_DIR||join(root,'data'));await mkdir(dataDir,{recursive:true});
  const input=resolve(source),target=join(dataDir,'game.sqlite');if(input===target)throw new Error('备份不能是当前数据库自身');
  const release=await acquireDataLock(dataDir);let staged='';
  try{
    const manifest=JSON.parse(await readFile(input+'.manifest.json','utf8'));
    if(manifest.format!=='jigerpg-database'||manifest.schemaVersion!==SCHEMA_VERSION||!manifest.backupId||!manifest.gitCommit||manifest.sha256!==await sha256File(input))throw new Error('备份清单或 SHA256 校验失败');
    const candidate=new Database(input,{readonly:true,fileMustExist:true});
    try{
      if(candidate.pragma('integrity_check',{simple:true})!=='ok')throw new Error('备份完整性检查失败');
      if(candidate.pragma('foreign_key_check').length)throw new Error('备份关联完整性检查失败');
      if(Number(candidate.pragma('user_version',{simple:true}))!==SCHEMA_VERSION)throw new Error('备份数据库结构与当前程序不兼容');
      for(const table of ['metadata','campaigns','members','sessions','operations','migrations'])if(!candidate.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error(`备份缺少 ${table}`);
      staged=join(dataDir,`restore-${randomUUID()}.sqlite`);await candidate.backup(staged);
    }finally{candidate.close();}
    if(existsSync(target)){const current=new Database(target);try{await onlineBackup(current,join(dataDir,'backups'),'before-file-restore');current.pragma('wal_checkpoint(TRUNCATE)');}finally{current.close();}}
    const previous=join(dataDir,`previous-${randomUUID()}.sqlite`);let moved=false;
    try{
      if(existsSync(target)){await rename(target,previous);moved=true;}
      for(const suffix of ['-wal','-shm'])try{await unlink(target+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
      await rename(staged,target);staged='';
      if(moved)await unlink(previous);
    }catch(error){if(moved&&!existsSync(target))await rename(previous,target);throw error;}
    console.log('数据库已恢复；成员、恢复码和战役状态均保留。重新启动主机后分享新的临时公网地址。');
  }finally{if(staged)try{await unlink(staged);}catch{}await release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))restore().catch(error=>{console.error(error);process.exitCode=1;});
