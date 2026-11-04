import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function systemNodeVersion(env=process.env){try{return execFileSync('node',['--version'],{encoding:'utf8',windowsHide:true,env,stdio:['ignore','pipe','ignore']}).trim();}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function unusedPort(){const listener=createServer();await new Promise((ok,no)=>{listener.once('error',no);listener.listen(0,'127.0.0.1',ok);});const port=listener.address().port;await new Promise(ok=>listener.close(ok));return port;}
export async function stopOwnedProcess(child){if(child.exitCode===null&&Number.isInteger(child.pid)&&child.pid>0){try{execFileSync(join(process.env.SystemRoot||'C:/Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}if(child.exitCode===null)await new Promise(ok=>{const timer=setTimeout(ok,5000);child.once('exit',()=>{clearTimeout(timer);ok();});});}}
export async function verifyLauncher({projectRoot=project,env=process.env,timeoutMs=600_000,onStarted}={}){
if(process.platform!=='win32')throw new Error('This verifies the actual Windows launcher.');
const before=systemNodeVersion(env);
const modules=await lstat(join(projectRoot,'node_modules')).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
if(modules?.isSymbolicLink()&&!existsSync(join(projectRoot,'.tools/dependency-lock.sha256')))throw new Error('Cold verification cannot run npm ci over a shared node_modules junction. Use verify-distribution.mjs.');
const dataDir=resolve(projectRoot,'work/launcher-'+randomUUID());
const port=await unusedPort();
const powershell=join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve(projectRoot,'scripts/start.ps1'),'-LocalOnly','-NoOpen','-Port',String(port),'-DataDir',dataDir],{cwd:projectRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let diagnostic='',launchError;const capture=data=>{diagnostic=(diagnostic+String(data)).slice(-32000);};child.stderr.on('data',capture);child.stdout.on('data',capture);child.once('error',error=>{launchError=error;});
try{
  let health;
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(launchError)throw launchError;
    if(child.exitCode!==null)throw new Error('Launcher failed: '+diagnostic.replace(/#hostToken=[A-Za-z0-9_-]+/g,'#hostToken=[redacted]'));
    try{const response=await fetch(`http://localhost:${port}/api/health`,{signal:AbortSignal.timeout(500)});if(response.ok){health=await response.json();break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(health?.ok,true,'Windows launcher should build and start the actual host');
  const page=await fetch(`http://localhost:${port}/`);assert.equal(page.status,200);assert.match(await page.text(),/assets\/app-/);
  const after=systemNodeVersion(env);assert.equal(after,before);
  const result={windowsPowerShellLauncher:true,productionPage:true,systemNodeUnchanged:true,systemNodeVersion:after,dataIsolated:true};
  if(onStarted)await onStarted({projectRoot,dataDir,port,health});
  return result;
}finally{
  await stopOwnedProcess(child);
}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))verifyLauncher().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
