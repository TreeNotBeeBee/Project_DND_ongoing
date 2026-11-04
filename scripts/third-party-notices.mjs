import { createRequire } from 'node:module';
import { dirname,resolve,join } from 'node:path';
import { readFile,readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function thirdPartyNotices(){
  const sections=['JigeRPG third-party notices\n\nThis work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.\n\nSRD material was structured and adapted for this application.'];
  const visited=new Set();
  async function visit(name,parent){
    if(name.startsWith('@types/')||name==='@webgpu/types')return;
    const require=createRequire(join(parent,'package.json'));let directory=dirname(require.resolve(name));
    while(!existsSync(join(directory,'package.json'))){const next=dirname(directory);if(next===directory)throw new Error('Package metadata missing for '+name);directory=next;}
    const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));const key=pkg.name+'@'+pkg.version;if(visited.has(key))return;visited.add(key);
    const names=(await readdir(directory)).filter(file=>/^licen[cs]e(?:[.-](?:md|txt|mit))?$/i.test(file));
    const license=names.length?(await Promise.all(names.map(file=>readFile(join(directory,file),'utf8')))).join('\n'):String(pkg.license||'See package source');
    sections.push(`${key}\n${pkg.homepage||pkg.repository?.url||''}\n\n${license}`);
    for(const dependency of Object.keys(pkg.dependencies||{}))await visit(dependency,directory);
  }
  for(const name of ['react','react-dom','pixi.js'])await visit(name,project);
  sections.push('5e-bits structured data\nhttps://github.com/5e-bits/5e-srd-api\n\n'+await readFile(join(project,'src/content/raw/UPSTREAM-LICENSE.md'),'utf8'));
  return sections.join('\n\n'+'='.repeat(72)+'\n\n')+'\n';
}
