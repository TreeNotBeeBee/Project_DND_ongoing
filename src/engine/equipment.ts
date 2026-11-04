import type {Actor,ItemInstance} from '../shared/model.ts';
import {lookup,unprefix} from '../content/index.ts';
import {itemBaseEquipment} from './item-effects.ts';
export function equipmentInstance(actor:Actor,key:string,instanceId?:string):ItemInstance|undefined{
  if(key.startsWith('item:')&&key.endsWith(':attack'))return actor.inventory.find(i=>i.id===key.slice(5,-7)&&i.equipped&&i.quantity>0);
  if(instanceId){const i=actor.inventory.find(i=>i.id===instanceId&&i.equipped&&i.quantity>0);if(i&&unprefix(i.contentId)===unprefix(key))return i;}
  return actor.inventory.find(i=>i.equipped&&i.quantity>0&&unprefix(i.contentId)===unprefix(key));
}
export function equipmentData(actor:Actor,key:string){const item=equipmentInstance(actor,key);return lookup('equipment',item?(itemBaseEquipment(item)||item.contentId):key);}
