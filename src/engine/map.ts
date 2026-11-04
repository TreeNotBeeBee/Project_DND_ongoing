import type {Actor,Position,Scene} from '../shared/model.ts';
import {assert,integer} from './dice.ts';
import {tokenCells,tokenSideCells,footprintsOverlap} from './spatial.ts';
export const distance=(a:Position,b:Position,feet=5)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))*feet;
const cross=(a:Position,b:Position,c:Position)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function crosses(a:Position,b:Position,c:Position,d:Position){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);if(x===0&&y===0)return Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y));return x*y<=0&&z*w<=0;}
export function lineOfSight(scene:Scene,a:Position,b:Position){return !scene.walls.some(w=>!(w.door&&w.open)&&crosses({x:a.x+.5,y:a.y+.5},{x:b.x+.5,y:b.y+.5},w.a,w.b));}
export function terrainAt(scene:Scene,p:Position,type:string){return scene.terrain.some(t=>t.type===type&&p.x>=t.x&&p.y>=t.y&&p.x<t.x+t.width&&p.y<t.y+t.height);}
export function coverBonus(scene:Scene,p:Position){return terrainAt(scene,p,'three-quarter-cover')?5:terrainAt(scene,p,'half-cover')?2:0;}
export function validatePosition(scene:Scene,p:Position){integer(p?.x,0,scene.width-1,'Position x');integer(p?.y,0,scene.height-1,'Position y');}
export function validateTokenPosition(scene:Scene,actor:Actor,p:Position,actors:Actor[]=[]){
  validatePosition(scene,p);const side=tokenSideCells(actor,scene.gridFeet);
  assert(p.x+side<=scene.width&&p.y+side<=scene.height,'TOKEN_BOUNDS','The complete creature footprint must fit inside the scene');
  assert(!actors.some(other=>other.id!==actor.id&&!other.dead&&!other.draft&&footprintsOverlap(actor,other,p,other.position,scene.gridFeet)),'OCCUPIED','A creature occupies this footprint');
  for(const cell of tokenCells(actor,p,scene.gridFeet)){
    if(cell.x<p.x+side-1)assert(lineOfSight(scene,cell,{x:cell.x+1,y:cell.y}),'WALL','A wall divides the creature footprint');
    if(cell.y<p.y+side-1)assert(lineOfSight(scene,cell,{x:cell.x,y:cell.y+1}),'WALL','A wall divides the creature footprint');
  }
}
export function pathCost(scene:Scene,actor:Actor,path:Position[],actors:Actor[],options:{crawling?:boolean}={}){assert(Array.isArray(path)&&path.length>0&&path.length<=500,'INVALID_PATH','Supply 1..500 grid positions');let prev=actor.position,cost=0;for(const next of path){validateTokenPosition(scene,actor,next,actors);assert(distance(prev,next,1)===1,'INVALID_PATH','Movement path must contain adjacent cells');const from=tokenCells(actor,prev,scene.gridFeet),to=tokenCells(actor,next,scene.gridFeet);assert(from.every((cell,index)=>lineOfSight(scene,cell,to[index])),'WALL','Movement is blocked by a wall or closed door');cost+=scene.gridFeet*(1+(to.some(cell=>terrainAt(scene,cell,'difficult'))?1:0)+(options.crawling?1:0));prev=next;}return cost;}
