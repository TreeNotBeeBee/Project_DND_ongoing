import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createApplication } from './app.js';

export { createApplication } from './app.js';
export async function startServer() {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const port=Number(process.env.PORT||8080);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 必须为 1 到 65535');
  const runtime=await createApplication({dataDir:process.env.JIGE_DATA_DIR||resolve(root,'data'),distDir:resolve(root,'dist'),hostToken:process.env.JIGE_HOST_TOKEN});
  try{await runtime.listen(port);}catch(error){await runtime.close();throw error;}
  console.log(`JigeRPG 主机已启动：http://localhost:${port}/#hostToken=${runtime.hostToken}`);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await runtime.close();process.exitCode=0;};process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  return runtime;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startServer().catch(error=>{console.error(error);process.exitCode=1;});
