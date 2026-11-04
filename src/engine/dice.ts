import type { Dice } from '../shared/model.ts';
export class RuleError extends Error {
  code:string;
  constructor(code:string,message:string){super(message);this.name='RuleError';this.code=code;}
}
export function assert(condition:unknown,code:string,message:string):asserts condition { if(!condition)throw new RuleError(code,message); }
export function integer(v:unknown,min:number,max:number,label:string):number {assert(Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max,'INVALID_NUMBER',`${label} must be an integer ${min}..${max}`);return Number(v);}
export function rollExpression(expression:string,dice:Dice,critical=false):{expression:string;rolls:number[];total:number} {
  const clean=String(expression).replace(/\s/g,'').toLowerCase();
  assert(clean.length<=200&&/^[+-]?(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/.test(clean),'INVALID_DICE','Invalid dice expression; use dice and signed integer terms, e.g. 2d6+1d4+3');
  const terms=clean.match(/[+-]?(?:\d*d\d+|\d+)/g)!;
  let total=0,count=0;const rolls:number[]=[];
  for(const term of terms){const m=term.match(/^([+-]?)(\d*)d(\d+)$/);if(!m){const n=Number(term);assert(Number.isSafeInteger(n)&&Math.abs(n)<=1e6,'INVALID_DICE','Dice modifier is too large');total+=n;continue;}
    const number=integer(Number(m[2]||1),1,1000,'Dice count')*(critical?2:1),sides=integer(Number(m[3]),2,1000,'Dice sides');count+=number;assert(count<=2000,'INVALID_DICE','Too many dice');
    for(let i=0;i<number;i++){const r=integer(dice(sides),1,sides,'Injected die');rolls.push(r);total+=(m[1]==='-'?-1:1)*r;}
  }assert(Number.isSafeInteger(total),'INVALID_DICE','Dice overflow');return {expression:clean,rolls,total};
}
export const modifier=(score:number)=>Math.floor((score-10)/2);
export const uid=()=>globalThis.crypto.randomUUID();
