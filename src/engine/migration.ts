import type {Actor,MigrationReport,GameState,Member} from '../shared/model.ts';
import {ABILITIES} from '../shared/model.ts';
import {entries} from '../content/index.ts';
import {createActor} from './actors.ts';
import {assert} from './dice.ts';
import {lineOfSight} from './map.ts';
import {hasEffect} from './actors.ts';
export function migrateLegacy(payload:unknown,fingerprint:string):{actors:Actor[];report:MigrationReport}{
  assert(payload&&typeof payload==='object'&&!Array.isArray(payload),'INVALID_IMPORT','Expected a legacy character or account object');assert(typeof fingerprint==='string'&&fingerprint.length>=8,'INVALID_FINGERPRINT','Server fingerprint required');
  let p=payload as Record<string,any>;
  const stored=p.rawStorage??(p.format==='jigerpg-legacy-storage'?p.raw:undefined);
  if(p.format==='jigerpg-legacy-storage'||p.format==='jigerpg-raw-backup'||stored){
    assert(stored&&typeof stored==='object'&&!Array.isArray(stored),'INVALID_IMPORT','Legacy storage wrapper needs raw strings');
    if(Object.hasOwn(p,'characters'))assert(p.characters&&typeof p.characters==='object'&&!Array.isArray(p.characters),'INVALID_IMPORT','Legacy account characters must be a keyed object');
    const characters:Record<string,any>=Object.assign(Object.create(null),p.characters||{});
    for(const [key,text] of Object.entries(stored)){if(!key.startsWith('jigerpg_char_'))continue;assert(typeof text==='string','INVALID_IMPORT',`Legacy character ${key} must retain its original JSON string`);try{characters[key.slice('jigerpg_char_'.length)]=JSON.parse(text);}catch{assert(false,'INVALID_IMPORT',`Invalid legacy JSON at ${key}`);}}
    p={characters};
  }
  if(Object.hasOwn(p,'characters'))assert(p.characters&&typeof p.characters==='object'&&!Array.isArray(p.characters),'INVALID_IMPORT','Legacy account characters must be a keyed object');
  const source=p.characters?Object.entries(p.characters):[[p.id||'legacy-character',p]];
  const known=new Set(source.map(([id])=>String(id)));
  for(let index=0;index<source.length;index++){
    const [parentId,parent]=source[index] as [string,any];
    assert(parent&&typeof parent==='object'&&!Array.isArray(parent),'INVALID_IMPORT',`Invalid character ${parentId}; the entire import was cancelled`);
    if(parent.companions!==undefined)assert(Array.isArray(parent.companions),'INVALID_IMPORT',`Invalid companions collection on ${parentId}`);
    for(const [n,pet] of (Array.isArray(parent?.companions)?parent.companions:[]).entries()){
      assert(pet&&typeof pet==='object'&&!Array.isArray(pet),'INVALID_IMPORT',`Invalid embedded companion ${n} on ${parentId}; the entire import was cancelled`);const oldId=String(pet.id||`${parentId}-embedded-${n}`);if(known.has(oldId))continue;
      known.add(oldId);source.push([oldId,{...pet,type:'companion',ownerId:String(parentId)}]);assert(source.length<=1000,'INVALID_IMPORT','Too many nested companions');
    }
  }
  assert(source.length>0&&source.length<=1000,'INVALID_IMPORT','Import must contain 1..1000 characters');
  const report:MigrationReport={id:`migration-${fingerprint}`,fingerprint,version:3,importedAt:new Date().toISOString(),actors:[],issues:[],original:structuredClone(payload)};const actors:Actor[]=[];
  // Canonical ordering makes ids independent of JSON key order. An ordinal
  // avoids collisions from truncating a long or percent-encoded legacy id.
  const idMap=new Map([...source].map(([oldId])=>String(oldId)).sort().map((oldId,index)=>[oldId,`migrated-${fingerprint}-${index.toString(36)}`]));
  const idFor=(oldId:string)=>idMap.get(oldId)||`missing-parent:${encodeURIComponent(oldId).slice(0,100)}`;
  for(const [oldId,value] of source){const old=value as Record<string,any>;
    const issues=['Choose and verify a 2024 SRD class, background, species and creation options. Original custom HP, MP, race multipliers and progression have no automatic 5e equivalent.'];const abilities=Object.fromEntries(ABILITIES.map((a,i)=>{const n=Number(old[['strength','dexterity','constitution','intelligence','wisdom','charisma'][i]]);if(!Number.isInteger(n)||n<3||n>20){issues.push(`Original ${a}=${old[['strength','dexterity','constitution','intelligence','wisdom','charisma'][i]]??'missing'} retained in backup; draft uses 10 pending review.`);return [a,10];}return[a,n];})) as Actor['abilities'];
    const inventory:Actor['inventory']=[];
    for(const [n,it] of (Array.isArray(old.items)?old.items:[]).entries()){const name=String(it?.name||'Unknown item');const hits=entries.filter(e=>e.category==='equipment'&&e.name.toLowerCase()===name.toLowerCase());if(hits.length===1)inventory.push({id:`${idFor(String(oldId))}-item-${n}`,contentId:hits[0].id,name,quantity:Math.max(1,Math.min(999,Number(it.qty)||1)),equipped:false,notes:String(it.desc||'')});else issues.push(`Item “${name}” kept in original backup and notes; no unambiguous SRD mapping.`);}
    const a=createActor({id:idFor(String(oldId)),name:String(old.name||'Imported adventurer'),abilities,kind:old.type==='companion'?'companion':'hero',draft:true,inventory,portrait:typeof old.avatar==='string'?old.avatar:undefined,notes:[String(old.storyNote||''),'--- Legacy migration ---',`Original ID: ${oldId}`,`Original job: ${String(old.job||'')}; level: ${String(old.level||'')}`,`Owner reference: ${String(old.ownerId||'')}`,`Items: ${(old.items||[]).map?.((i:any)=>`${i.name} x${i.qty||1}: ${i.desc||''}`).join('\n')||''}`].join('\n'),choices:{legacyOwnerId:old.ownerId? idFor(String(old.ownerId)):undefined}});
    a.migrationId=report.id;a.migrationIssues=issues;actors.push(a);report.actors.push({oldId:String(oldId),newId:a.id,issues});
  }
  const actorIds=new Set(actors.map(a=>a.id));
  for(const a of actors){const parent=a.choices?.legacyOwnerId;if(typeof parent==='string'){if(actorIds.has(parent))a.choices!.parentActorId=parent;else{const issue='Original companion owner is absent from the import; choose a parent actor before activation.';a.migrationIssues!.push(issue);report.actors.find(r=>r.newId===a.id)!.issues.push(issue);}}}
  assert(actors.length,'INVALID_IMPORT','No valid legacy characters');return {actors,report};
}
export function projectState(state:GameState,member:Member):GameState{
  const copy=structuredClone(state);if(member.role==='gm')return copy;
  const observers=copy.actors.filter(a=>a.ownerId===member.id&&!a.draft&&!a.dead&&!['blinded','unconscious'].some(c=>hasEffect(a,c)));
  const obscured=copy.actors.filter(a=>a.ownerId!==member.id&&(a.hidden||copy.scene.fog&&!observers.some(observer=>lineOfSight(copy.scene,observer.position,a.position))));
  const hidden=new Set(obscured.map(a=>a.id));copy.actors=copy.actors.filter(a=>!hidden.has(a.id));
  copy.actors=copy.actors.map(a=>({...a,effects:a.effects.filter(e=>!e.gmOnly)}));
  // Monster records carry hidden abilities and notes even when their token is visible.
  copy.actors=copy.actors.map(a=>a.ownerId===member.id?a:{...a,notes:'',portrait:a.portrait,inventory:[],spells:[],features:[],choices:undefined,migrationIssues:undefined,resources:[],monsterActions:undefined,resistances:undefined,immunities:undefined,vulnerabilities:undefined});
  copy.events=copy.events.filter(e=>!e.gmOnly&&(!['inventory','equipment'].includes(e.type)||copy.actors.some(a=>a.id===e.actorId&&a.ownerId===member.id))&&(!e.actorId||!hidden.has(e.actorId))&&!e.targetIds?.some(id=>hidden.has(id))&&!obscured.some(a=>e.message.includes(a.id)||a.name.length>1&&e.message.includes(a.name))).map(e=>({...e,changes:undefined}));
  copy.choices=copy.choices.filter(c=>c.ownerId===member.id&&!hidden.has(c.actorId)).map(c=>({...c,prompt:obscured.reduce((text,a)=>text.replaceAll(a.name,'an unseen creature'),c.prompt),payload:{}}));const activeId=copy.combat.order[copy.combat.turn];copy.combat.order=copy.combat.order.filter(id=>!hidden.has(id));copy.combat.turn=copy.combat.order.indexOf(activeId);copy.combat.budgets=Object.fromEntries(Object.entries(copy.combat.budgets).filter(([id])=>!hidden.has(id)));
  return copy;
}
