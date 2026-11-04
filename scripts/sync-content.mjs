// Development-time import. Runtime never contacts the API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const commit = '67d8c6aad9a273862fc5ff5f633fcdc06130b94c';
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/content/raw');
const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new Error('Pass packages/5e-database/src/2024/en from the pinned upstream checkout');
const categories = ['Ability-Scores','Alignments','Backgrounds','Classes','Conditions','Damage-Types','Equipment-Categories','Equipment','Feats','Features','Languages','Levels','Magic-Items','Magic-Schools','Monsters','Poisons','Proficiencies','Skills','Species','Spells','Subclasses','Subspecies','Traits','Weapon-Mastery-Properties','Weapon-Properties'];
await fs.mkdir(directory,{recursive:true});
const raw = {}, hashes = {};
for (const category of categories) {
  const name = `5e-SRD-${category}.json`;
  const bytes = await fs.readFile(path.join(sourceDirectory,name));
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  const values = JSON.parse(bytes.toString('utf8'));
  for(const value of values) if(value.url && !value.url.startsWith('/api/2024/')) throw new Error(`Non-2024 source: ${name}/${value.index}`);
  raw[category.toLowerCase()] = values;
}
await fs.writeFile(path.join(directory,'srd-2024.json'),JSON.stringify(raw));
await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({ruleset:'srd-5.2.1',edition:2024,upstream:'https://github.com/5e-bits/5e-srd-api',commit,path:'packages/5e-database/src/2024/en',license:'MIT (database structure); CC-BY-4.0 (SRD material)',officialSource:'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',hashes},null,2)+'\n');
console.log(`Imported ${Object.values(raw).reduce((n,a)=>n+a.length,0)} 2024 entries at ${commit}`);
