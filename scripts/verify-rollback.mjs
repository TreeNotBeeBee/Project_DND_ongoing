import { register } from 'tsx/esm/api';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function checkpointProject(checkout){
  for(const candidate of [checkout,join(checkout,'origin')])if(existsSync(join(candidate,'package.json'))&&existsSync(join(candidate,'src/server/app.ts')))return candidate;
  throw new Error('Checkpoint has no supported application layout.');
}
export async function verifyRollback(reference='HEAD'){
register();
const repository=project;
const checkpoint=execFileSync('git',['-C',repository,'rev-parse',reference],{encoding:'utf8',windowsHide:true}).trim();
const proofRoot=join(repository,'work','rollback-proof-'+randomUUID().slice(0,8));
const checkout=join(proofRoot,'checkout'),dataDir=join(proofRoot,'data');
await mkdir(proofRoot,{recursive:true});
execFileSync('git',['-C',repository,'worktree','add','--detach',checkout,checkpoint],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const checkpointRoot=checkpointProject(checkout);
await symlink(join(project,'node_modules'),join(checkpointRoot,'node_modules'),'junction');
const child=join(proofRoot,'seed.mjs');
await writeFile(child,`
import {register} from ${JSON.stringify(pathToFileURL(join(project,'node_modules/tsx/dist/esm/api/index.mjs')).href)};
register();
const {createApplication}=await import(${JSON.stringify(pathToFileURL(join(checkpointRoot,'src/server/app.ts')).href)});
const {onlineBackup}=await import(${JSON.stringify(pathToFileURL(join(checkpointRoot,'src/server/database.ts')).href)});
const runtime=await createApplication({dataDir:${JSON.stringify(dataDir)},hostToken:'rollback-test-only'});
try{
 const address=await runtime.listen(0);const origin='http://localhost:'+address.port;
 const headers={Origin:origin,'Content-Type':'application/json','X-Jige-Request':'1'};
 const response=await fetch(origin+'/api/campaigns',{method:'POST',headers,body:JSON.stringify({name:'Checkpoint campaign',gmName:'QA GM',hostToken:'rollback-test-only'})});
 if(response.status!==201)throw new Error(await response.text());
 const snapshot=await response.json();const cookie=response.headers.get('set-cookie').split(';')[0];
 const added=await fetch(origin+'/api/command',{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify({operationId:'rollback-proof-create',expectedRev:snapshot.state.rev,type:'actor.create',payload:{name:'Checkpoint actor',draft:true}})});
 if(added.status!==200)throw new Error(await added.text());
 const committed=await added.json();const backup=await onlineBackup(runtime.db,${JSON.stringify(join(proofRoot,'backups'))},'checkpoint');
 console.log(JSON.stringify({backup,cookie,snapshot:committed.snapshot,serverId:runtime.serverId}));
}finally{await runtime.close();}
`);
const seeded=JSON.parse(execFileSync(process.execPath,[child],{cwd:checkpointRoot,encoding:'utf8',windowsHide:true,timeout:30_000}));
const manifest=JSON.parse(await readFile(seeded.backup+'.manifest.json','utf8'));
assert.equal(manifest.gitCommit,checkpoint);
// Simulate a later code version having written different state, using only isolated QA data.
const changed=new Database(join(dataDir,'game.sqlite'));
try{
 const next=structuredClone(seeded.snapshot.state);next.name='Later changed state';next.actors[0].name='Later actor';next.rev++;
 changed.prepare('UPDATE campaigns SET name=?,state=?,revision=? WHERE id=?').run(next.name,JSON.stringify(next),next.rev,next.id);
}finally{changed.close();}
execFileSync(process.execPath,[join(checkpointRoot,'scripts/restore.mjs'),seeded.backup],{cwd:checkpointRoot,env:{...process.env,JIGE_DATA_DIR:dataDir},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30_000});
const {createApplication}=await import(pathToFileURL(join(checkpointRoot,'src/server/app.ts')).href);
const restored=await createApplication({dataDir,hostToken:'rollback-test-only'});
try{
 const address=await restored.listen(0);const response=await fetch('http://localhost:'+address.port+'/api/state',{headers:{Cookie:seeded.cookie}});
 assert.equal(response.status,200);const snapshot=await response.json();
 assert.equal(restored.serverId,seeded.serverId);assert.deepEqual(snapshot.state,seeded.snapshot.state);
 const proof={codeCommit:checkpoint,schemaVersion:manifest.schemaVersion,backupId:manifest.backupId,backupSha256:manifest.sha256,restoredStateMatches:true,restoredSessionWorks:true,checkpointCheckout:checkout};
 await writeFile(join(proofRoot,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await restored.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))verifyRollback(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
