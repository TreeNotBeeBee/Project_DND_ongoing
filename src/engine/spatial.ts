import type {Actor,Position} from '../shared/model.ts';
import {tokenFootprint} from './size.ts';

/** Actor.position is the top-left occupied cell. Tiny/Small still use one cell
 * in this grid UI; the published size rank remains distinct for other rules. */
export function tokenSideCells(actor:Actor,gridFeet=5):number{return Math.max(1,Math.ceil(tokenFootprint(actor)*5/gridFeet));}
export function tokenCells(actor:Actor,position:Position=actor.position,gridFeet=5):Position[]{
  const side=tokenSideCells(actor,gridFeet),cells:Position[]=[];
  for(let y=0;y<side;y++)for(let x=0;x<side;x++)cells.push({x:position.x+x,y:position.y+y});
  return cells;
}
export function footprintsOverlap(a:Actor,b:Actor,aPosition:Position=a.position,bPosition:Position=b.position,gridFeet=5):boolean{
  const aSide=tokenSideCells(a,gridFeet),bSide=tokenSideCells(b,gridFeet);
  return aPosition.x<bPosition.x+bSide&&bPosition.x<aPosition.x+aSide&&aPosition.y<bPosition.y+bSide&&bPosition.y<aPosition.y+aSide;
}
/** Minimum grid distance between occupied cells, rather than their anchors. */
export function actorDistance(a:Actor,b:Actor,gridFeet=5):number{
  const aSide=tokenSideCells(a,gridFeet),bSide=tokenSideCells(b,gridFeet);
  return Math.max(0,a.position.x-(b.position.x+bSide-1),b.position.x-(a.position.x+aSide-1),a.position.y-(b.position.y+bSide-1),b.position.y-(a.position.y+aSide-1))*gridFeet;
}
/** Cell-coordinate centre: add 0.5 when converting to a canvas coordinate. */
export function tokenCentre(actor:Actor,position:Position=actor.position,gridFeet=5):Position{
  const offset=(tokenSideCells(actor,gridFeet)-1)/2;return{x:position.x+offset,y:position.y+offset};
}
