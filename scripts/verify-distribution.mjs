// Manual, isolated verification of an actual source ZIP. Never uses production data
// or copies an installed runtime/node_modules into the extracted application.
import assert from 'node:assert/strict';
import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {mkdir,mkdtemp,readdir,lstat,readFile,writeFile,copyFile,unlink,rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,join,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
import {verifyLauncher,systemNodeVersion} from './verify-launcher.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function distributionArguments(args){
 const options={archive:null,commit:null,downloadCache:process.env.JIGE_DOWNLOAD_CACHE||'',cleanup:false};
 for(let i=0;i<args.length;i++){
  const key=args[i];if(key==='--cleanup'){options.cleanup=true;continue;}
  if(!['--archive','--commit','--download-cache'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Usage: --archive <source.zip> OR --commit <40-character GitHub SHA> [--download-cache <directory>] [--cleanup]');
  const value=args[++i];if(key==='--archive')options.archive=resolve(value);else if(key==='--commit')options.commit=value;else options.downloadCache=resolve(value);
 }
 if(!!options.archive===!!options.commit||options.commit&&!/^[a-f0-9]{40}$/i.test(options.commit))throw new Error('Select one local source ZIP or one exact 40-character GitHub commit.');
 return options;
}
export async function archiveProject(extracted){
 if(existsSync(join(extracted,'package.json')))return extracted;
 const candidates=[];for(const entry of await readdir(extracted,{withFileTypes:true}))if(entry.isDirectory()&&existsSync(join(extracted,entry.name,'package.json')))candidates.push(join(extracted,entry.name));
 if(candidates.length!==1)throw new Error('Source ZIP must contain one root-layout application.');
 return candidates[0];
}
export async function removeOwnedDistribution(directory,workRoot){
 const target=resolve(directory),base=resolve(workRoot);
 assert.equal(dirname(target),base,'Cleanup must stay directly in the QA work directory');assert.ok(basename(target).startsWith('distribution-'),'Cleanup requires an owned distribution directory');
 const info=await lstat(target);assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'QA root cannot be a junction or symlink');
 async function retry(operation){for(let attempt=0;;attempt++){try{return await operation();}catch(error){if(error.code==='ENOENT')return;if(attempt>=19||!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;await new Promise(ok=>setTimeout(ok,100));}}}
 async function remove(path){const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isDirectory()){await retry(()=>unlink(path));return;}for(const entry of await readdir(path))await remove(join(path,entry));await retry(()=>rmdir(path));}
 await remove(target);
}
async function sha256(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}

export async function verifyDistribution(options){
 if(process.platform!=='win32')throw new Error('This verifies the Windows source-ZIP bootstrap.');
 const workRoot=join(project,'work');await mkdir(workRoot,{recursive:true});const qaRoot=await mkdtemp(join(workRoot,'distribution-'));
 const archive=join(qaRoot,'source.zip'),extracted=join(qaRoot,'解压测试 with spaces');await mkdir(extracted);
 const proof={sourceKind:options.commit?'github-exact-commit':'local-archive',requestedCommit:options.commit||null,qaRoot};
 try{
  if(options.commit){
   const url=`https://codeload.github.com/TreeNotBeeBee/Project_DND_ongoing/zip/${options.commit}`;console.log('Downloading exact GitHub source commit '+options.commit);
   const response=await fetch(url,{signal:AbortSignal.timeout(600_000)});if(!response.ok||!response.body)throw new Error('GitHub source ZIP download failed: HTTP '+response.status);
   await pipeline(Readable.fromWeb(response.body),createWriteStream(archive));proof.downloadUrl=url;
  }else{console.log('Verifying local source archive');await copyFile(options.archive,archive);}
  proof.archiveSha256=await sha256(archive);
  const powershell=join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const extraction="$ErrorActionPreference='Stop'; if($PSVersionTable.PSEdition -eq 'Desktop'){$env:PSModulePath=\"$PSHOME\\Modules;${env:ProgramFiles}\\WindowsPowerShell\\Modules\"}; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:JIGE_QA_ARCHIVE); try{foreach($entry in $zip.Entries){$name=$entry.FullName.Replace('\\','/'); if([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or $name.Split('/') -contains '..'){throw 'Unsafe source ZIP path'}}}finally{$zip.Dispose()}; Expand-Archive -LiteralPath $env:JIGE_QA_ARCHIVE -DestinationPath $env:JIGE_QA_EXTRACTED";
  execFileSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',extraction],{env:{...process.env,JIGE_QA_ARCHIVE:archive,JIGE_QA_EXTRACTED:extracted},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:120_000});
  const freshProject=await archiveProject(extracted);proof.project=freshProject;
  for(const name of ['.git','.tools','node_modules','data','dist','origin'])assert.equal(existsSync(join(freshProject,name)),false,'Source archive unexpectedly contains '+name);
  for(const name of ['package-lock.json','runtime.json','scripts/start.ps1','src/server/main.ts'])assert.ok(existsSync(join(freshProject,name)),'Missing root release file '+name);
  proof.startedWithoutInstalledTools=true;
  const env={...process.env,PATH:''};for(const key of Object.keys(env))if(key.startsWith('JIGE_'))delete env[key];
  if(options.downloadCache)env.JIGE_DOWNLOAD_CACHE=resolve(options.downloadCache);
  assert.equal(systemNodeVersion(env),null);proof.systemNodeAbsent=true;
  console.log('Bootstrapping verified Node ZIP, fresh npm ci, SQLite, production build and HTTP host');
  const launched=await verifyLauncher({projectRoot:freshProject,env,timeoutMs:600_000,onStarted:async()=>{
   const runtime=JSON.parse(await readFile(join(freshProject,'runtime.json'),'utf8')),node=join(freshProject,'.tools',`node-v${runtime.node.version}-win-x64`,'node.exe');
   assert.equal(execFileSync(node,['--version'],{env,encoding:'utf8',windowsHide:true}).trim(),'v'+runtime.node.version);proof.nodeVersion=runtime.node.version;
   assert.equal(await sha256(join(freshProject,'.tools',`node-v${runtime.node.version}-win-x64.zip`)),runtime.node.sha256);proof.runtimeZipShaVerified=true;
   const modules=await lstat(join(freshProject,'node_modules'));assert.ok(modules.isDirectory()&&!modules.isSymbolicLink(),'npm ci must create fresh local dependencies');
   const lockHash=await sha256(join(freshProject,'package-lock.json')),stamp=(await readFile(join(freshProject,'.tools/dependency-lock.sha256'),'utf8')).trim().toLowerCase();assert.equal(stamp,lockHash);proof.freshNpmCi=true;
   proof.sqlite=JSON.parse(execFileSync(node,['-e',"const D=require('better-sqlite3');const d=new D(':memory:');console.log(JSON.stringify(d.prepare('select sqlite_version() as version').get()));d.close()"],{cwd:freshProject,env,encoding:'utf8',windowsHide:true})).version;
   const tests=execFileSync(node,['--import','tsx','--test','tests/server-tools.test.mjs'],{cwd:freshProject,env,encoding:'utf8',windowsHide:true,timeout:120_000});assert.match(tests,/\bfail 0\b/);proof.zipBackupRestoreTests=true;
  }});
  Object.assign(proof,launched,{completedAt:new Date().toISOString()});const proofPath=join(workRoot,basename(qaRoot)+'.json');await writeFile(proofPath,JSON.stringify(proof,null,2)+'\n');
  if(options.cleanup)await removeOwnedDistribution(qaRoot,workRoot);
  console.log(JSON.stringify({...proof,proofPath,cleaned:!!options.cleanup}));return proof;
 }catch(error){await writeFile(join(qaRoot,'failure.json'),JSON.stringify({...proof,error:error.message},null,2)+'\n');console.error('Isolated distribution evidence: '+qaRoot);throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))verifyDistribution(distributionArguments(process.argv.slice(2))).catch(error=>{console.error(error);process.exitCode=1;});
