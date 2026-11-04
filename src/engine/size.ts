import type { Actor } from '../shared/model.ts';
import { lookup } from '../content/index.ts';
export const SIZE_CATEGORIES=['tiny','small','medium','large','huge','gargantuan'] as const;
export function creatureSizeRank(actor:Actor):number{
  const published=['monster','companion'].includes(actor.kind)&&actor.choices?.monsterId?lookup('monsters',String(actor.choices.monsterId))?.size:lookup('species',actor.speciesId)?.size;
  const text=String(published||'').toLowerCase();
  let rank=SIZE_CATEGORIES.findIndex(size=>text===size);
  if(rank<0)rank=['monster','companion'].includes(actor.kind)?(actor.size!>=4?5:actor.size!>=3?4:actor.size!>=2?3:2):2;
  const shifts=(actor.effects||[]).map(effect=>effect.modifiers?.sizeDelta||0);
  // Same named effects do not compound; one enlargement and one reduction can cancel.
  rank+=Math.max(0,...shifts)+Math.min(0,...shifts);
  return Math.max(0,Math.min(5,rank));
}
export function canGrappleSize(source:Actor,target:Actor):boolean{return creatureSizeRank(target)<=creatureSizeRank(source)+1;}
export function canPushWithMastery(target:Actor):boolean{return creatureSizeRank(target)<=3;}
export function tokenFootprint(actor:Actor):number{return [.5,1,1,2,3,4][creatureSizeRank(actor)];}
