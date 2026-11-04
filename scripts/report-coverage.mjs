import { register } from 'tsx/esm/api';
import { mkdir,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
register();
const {entries,coverage,source}=await import('../src/content/index.ts');
let gitCommit='unversioned';try{gitCommit=execFileSync('git',['-C',project,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();}catch{}
const document={...coverage,generatedAt:new Date().toISOString(),evaluatedCodeCommit:gitCommit,source,entries:entries.map(entry=>({id:entry.id,name:entry.name,category:entry.category,status:entry.automation,reason:entry.reason||null,sourcePage:entry.sourcePage||null}))};
const folder=resolve(project,'reference');await mkdir(folder,{recursive:true});await writeFile(resolve(folder,'automation-coverage.json'),JSON.stringify(document,null,2)+'\n');
console.log(JSON.stringify({total:document.total,complete:document.complete,counts:document.counts,evaluatedCodeCommit:gitCommit}));
