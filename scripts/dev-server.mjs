import { register } from 'tsx/esm/api';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
register();
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT||8080),uiPort=Number(process.env.JIGE_DEV_PORT||5173);
if(![port,uiPort].every(value=>Number.isInteger(value)&&value>=1&&value<=65535))throw new Error('Invalid development port');
const {createApplication}=await import('../src/server/app.ts');
const host=await createApplication({dataDir:resolve(root,'work/dev-data'),localOrigins:[`http://localhost:${uiPort}`,`http://127.0.0.1:${uiPort}`]});
try{await host.listen(port);}catch(error){await host.close();throw error;}
console.log(`Development UI: http://127.0.0.1:${uiPort}/app.html#hostToken=${host.hostToken}`);
console.log(`Development API: http://127.0.0.1:${port}; isolated data: work/dev-data`);
let closing=false;const close=async()=>{if(closing)return;closing=true;await host.close();};
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
