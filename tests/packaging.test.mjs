import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {checkpointProject} from '../scripts/verify-rollback.mjs';
import {systemNodeVersion} from '../scripts/verify-launcher.mjs';
import {distributionArguments,archiveProject,removeOwnedDistribution} from '../scripts/verify-distribution.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function temporary(t){const directory=await mkdtemp(join(tmpdir(),'jige-packaging-'));t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('jige-packaging-'));await rm(directory,{recursive:true,force:true});});return directory;}

test('rollback verification resolves both flat releases and historical origin-layout checkpoints',async t=>{
 const temporaryRoot=await temporary(t),flat=join(temporaryRoot,'flat'),legacy=join(temporaryRoot,'legacy');
 for(const candidate of [flat,join(legacy,'origin')]){await mkdir(join(candidate,'src/server'),{recursive:true});await writeFile(join(candidate,'package.json'),'{}');await writeFile(join(candidate,'src/server/app.ts'),'export{};');}
 assert.equal(checkpointProject(flat),flat);assert.equal(checkpointProject(legacy),join(legacy,'origin'));assert.throws(()=>checkpointProject(temporaryRoot),/no supported application layout/);
});
test('Windows launch wrappers address the flat scripts and local npm start uses the same host options',async()=>{
 for(const[file,script]of [['启动JigeRPG.cmd','start.ps1'],['安装或修复环境.cmd','setup.ps1']]){const text=await readFile(join(project,file),'utf8');assert.ok(text.includes(`%~dp0scripts\\${script}`));assert.equal(text.includes('origin\\scripts'),false);}
 const pkg=JSON.parse(await readFile(join(project,'package.json'),'utf8'));assert.equal(pkg.scripts['start:local'],'node scripts/host.mjs --local');assert.equal(pkg.scripts.legacy,undefined);
});
test('verified runtime cache is copied only after its pinned SHA matches', {skip:process.platform!=='win32'},async t=>{
 const directory=await temporary(t),cache=join(directory,'cache'),destination=join(directory,'runtime.zip');await mkdir(cache);await writeFile(join(cache,'runtime.zip'),'verified archive fixture');const sha=createHash('sha256').update('verified archive fixture').digest('hex');
 const env={...process.env,JIGE_QA_HELPER:join(project,'scripts/runtime-download.ps1'),JIGE_QA_CACHE:cache,JIGE_QA_DEST:destination,JIGE_QA_SHA:sha};
 const result=spawnSync(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-Command',"$ErrorActionPreference='Stop'; if($PSVersionTable.PSEdition -eq 'Desktop'){$env:PSModulePath=\"$PSHOME\\Modules;${env:ProgramFiles}\\WindowsPowerShell\\Modules\"}; . $env:JIGE_QA_HELPER; Get-VerifiedFile 'https://nodejs.org/dist/test/runtime.zip' $env:JIGE_QA_DEST $env:JIGE_QA_SHA $env:JIGE_QA_CACHE"],{env,encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.equal(await readFile(destination,'utf8'),'verified archive fixture');await rm(destination);await writeFile(join(cache,'runtime.zip'),'tampered archive');const rejected=spawnSync(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-Command',"$ErrorActionPreference='Stop'; if($PSVersionTable.PSEdition -eq 'Desktop'){$env:PSModulePath=\"$PSHOME\\Modules;${env:ProgramFiles}\\WindowsPowerShell\\Modules\"}; . $env:JIGE_QA_HELPER; Get-VerifiedFile 'https://nodejs.org/dist/test/runtime.zip' $env:JIGE_QA_DEST $env:JIGE_QA_SHA $env:JIGE_QA_CACHE"],{env,encoding:'utf8',windowsHide:true});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Cached download checksum mismatch/);await assert.rejects(()=>readFile(destination),{code:'ENOENT'});
});
test('launcher verification supports an environment with no system Node',()=>{assert.equal(systemNodeVersion({...process.env,PATH:join(tmpdir(),'no-node-installed-'+Date.now())}),null);});
test('source verification accepts one local archive or one immutable GitHub SHA and locates a GitHub ZIP prefix',async t=>{
 assert.throws(()=>distributionArguments([]),/Select one/);assert.throws(()=>distributionArguments(['--commit','main']),/exact 40-character/);assert.throws(()=>distributionArguments(['--archive','a.zip','--commit','a'.repeat(40)]),/Select one/);assert.equal(distributionArguments(['--commit','a'.repeat(40)]).commit,'a'.repeat(40));
 const directory=await temporary(t),prefixed=join(directory,'Project_DND_ongoing-'+'a'.repeat(40));await mkdir(prefixed);await writeFile(join(prefixed,'package.json'),'{}');assert.equal(await archiveProject(directory),prefixed);assert.equal(await archiveProject(prefixed),prefixed);
});
test('distribution cleanup cannot escape its owned work directory or follow a node_modules junction',async t=>{
 const directory=await temporary(t),work=join(directory,'work'),owned=join(work,'distribution-test'),external=join(directory,'external-dependencies');await mkdir(owned,{recursive:true});await mkdir(external);await writeFile(join(external,'keep.txt'),'do not delete');await symlink(external,join(owned,'node_modules'),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>removeOwnedDistribution(external,work));await removeOwnedDistribution(owned,work);assert.equal(await readFile(join(external,'keep.txt'),'utf8'),'do not delete');await assert.rejects(()=>readFile(join(owned,'node_modules/keep.txt')),{code:'ENOENT'});
});
