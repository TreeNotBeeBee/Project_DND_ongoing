import { register } from 'tsx/esm/api';
import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function backup(){
  register();const{onlineBackup}=await import('../src/server/database.ts');
  const dataDir=resolve(process.env.JIGE_DATA_DIR||join(root,'data'));
  const db=new Database(join(dataDir,'game.sqlite'),{readonly:true,fileMustExist:true});
  db.pragma('busy_timeout = 10000');
  try{const path=await onlineBackup(db,process.argv[2]?resolve(process.argv[2]):join(dataDir,'backups'));console.log(`一致性备份已保存：${path}`);return path;}finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))backup().catch(error=>{console.error(error);process.exitCode=1;});
