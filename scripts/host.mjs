import { register } from 'tsx/esm/api';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function extractTunnelUrl(text){return String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0]||null;}
export function parseArguments(args){
  const out={local:false,noOpen:false,port:undefined,dataDir:undefined};
  for(let i=0;i<args.length;i++){
    const value=args[i];if(value==='--local')out.local=true;else if(value==='--no-open')out.noOpen=true;
    else if(value==='--port'){const port=Number(args[++i]);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('--port 必须为 1 到 65535');out.port=port;}
    else if(value==='--data-dir'){const path=args[++i];if(!path||path.startsWith('--'))throw new Error('--data-dir 需要目录路径');out.dataDir=resolve(path);}
    else throw new Error(`不支持的启动参数：${value}`);
  }
  return out;
}
export async function host(){
  const flags=parseArguments(process.argv.slice(2));
  if(flags.port)process.env.PORT=String(flags.port);if(flags.dataDir)process.env.JIGE_DATA_DIR=flags.dataDir;
  register();
  const{startServer}=await import('../src/server/index.ts');
  const runtime=await startServer();
  if(!flags.noOpen){const url=`http://localhost:${runtime.server.address().port}/#hostToken=${runtime.hostToken}`;const command=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];const browser=spawn(command,args,{windowsHide:true,stdio:'ignore',shell:false});browser.once('error',error=>console.error('浏览器未自动打开，请使用上方本机地址：',error.message));browser.unref();}
  if(flags.local)return runtime;
  const candidates=[process.env.JIGE_CLOUDFLARED,resolve(root,'.tools/cloudflared.exe'),resolve(root,'.tools/cloudflared-windows-amd64.exe')].filter(Boolean);
  const binary=candidates.find(p=>existsSync(p));
  if(!binary){runtime.setPublicOrigin(null,'未找到官方 cloudflared；本机服务仍可使用。设置 JIGE_CLOUDFLARED 后重新启动。');console.error('未找到 cloudflared。请从 Cloudflare 官方下载 Windows amd64 稳定版并核验 SHA256，或设置 JIGE_CLOUDFLARED。');return runtime;}
  let child=null,stopping=false,retries=0,retryTimer=null,lastUrl='',buffer='';
  const run=()=>{
    if(stopping)return;
    const port=runtime.server.address().port;
    child=spawn(binary,['tunnel','--url',`http://127.0.0.1:${port}`],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    buffer='';
    const onData=async chunk=>{
      buffer=(buffer+String(chunk)).slice(-16384);
      const url=extractTunnelUrl(buffer);
      if(url&&url!==lastUrl){const changed=!!lastUrl;lastUrl=url;runtime.setPublicOrigin(url);console.log(`\n${changed?'公网地址已更换，请重新分享':'临时公网地址'}：${url}`);console.log('朋友打开此地址后输入战役邀请码。个人恢复码可在新网址恢复原角色。');try{console.log(await QRCode.toString(url,{type:'terminal',small:true}));}catch{}}
    };
    child.stdout.on('data',onData);child.stderr.on('data',onData);
    child.once('error',error=>{runtime.setPublicOrigin(null,`隧道启动失败：${error.message}`);console.error('隧道启动失败，本机仍可使用：',error.message);});
    child.once('exit',(code,signal)=>{
      child=null;if(stopping)return;runtime.setPublicOrigin(null,`隧道已停止（${code??signal}），本机仍可使用`);
      if(retries++<3){const delay=Math.min(1000*2**retries,10000);console.error(`隧道已断开，${delay/1000} 秒后重试；重新连接后地址可能变化。`);retryTimer=setTimeout(run,delay);}else console.error('隧道连续失败，已停止重试；本机服务仍可使用。检查网络后重新启动主机。');
    });
  };
  const stop=async()=>{if(stopping)return;stopping=true;if(retryTimer)clearTimeout(retryTimer);runtime.setPublicOrigin(null);const owned=child;child=null;if(owned&&!owned.killed)owned.kill();await runtime.close();};
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());process.once('exit',()=>{if(child&&!child.killed)child.kill();});
  run();
  return {...runtime,stop};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))host().catch(error=>{console.error(error);process.exitCode=1;});
