import type { ActionDefinition, Position } from './model.ts';
export interface AreaGeometry { shape: NonNullable<ActionDefinition['area']>['shape']; size: number; origin: Position; direction: Position; gridFeet: number; includeOrigin?: boolean; width?: number }
const epsilon=1e-8;
/** Coordinates are grid-space points. A cube's origin is on its near face. */
export function areaContains(area: AreaGeometry, point: Position): boolean {
  const {shape,size,origin,gridFeet}=area;
  if(![size,gridFeet,origin.x,origin.y,point.x,point.y].every(Number.isFinite)||size<=0||gridFeet<=0)throw new Error('Invalid spell-area geometry');
  const x=(point.x-origin.x)*gridFeet,y=(point.y-origin.y)*gridFeet;
  if(shape==='sphere'||shape==='cylinder')return x*x+y*y<=size*size+epsilon;
  let dx=area.direction.x,dy=area.direction.y;const norm=Math.hypot(dx,dy);
  if(norm<epsilon){dx=1;dy=0;}else{dx/=norm;dy/=norm;}
  const forward=x*dx+y*dy,side=Math.abs(-x*dy+y*dx);
  if(forward<-epsilon||forward>size+epsilon)return false;
  if(!area.includeOrigin&&Math.abs(x)+Math.abs(y)<epsilon)return false;
  if(shape==='cone')return side<=forward/2+epsilon; // width at a distance equals that distance
  if(shape==='line')return side<=(area.width??5)/2+epsilon;
  if(shape==='cube')return side<=size/2+epsilon;
  return false;
}
export function resolveSpellArea(action:ActionDefinition,caster:Position,options:{origin?:Position;direction?:Position;includeOrigin?:boolean},gridFeet=5):AreaGeometry{
  if(!action.area)throw new Error('This action has no area');
  const self=(action.range??0)===0;
  if(!self&&!options.origin)throw new Error('Select an area origin');
  const origin=self?caster:options.origin!;
  const aim=options.origin??{x:origin.x+1,y:origin.y};
  const direction=options.direction??{x:aim.x-caster.x,y:aim.y-caster.y};
  return {...action.area,origin:{...origin},direction,gridFeet,includeOrigin:options.includeOrigin};
}
