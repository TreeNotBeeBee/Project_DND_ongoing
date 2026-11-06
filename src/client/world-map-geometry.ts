import type { Position, Scene } from '../shared/model';
import type { TokenView } from '../shared/world';

export const actorInitial = (actor: Pick<TokenView, 'name'>) => Array.from(actor.name.trim())[0] || '?';
export const actorColor = (id: string) => ['#8fc9ac', '#c6a8e6', '#e3bb7b', '#8abce2', '#e3a5a5', '#a9c779'][Array.from(id).reduce((value, char) => value + char.charCodeAt(0), 0) % 6];
export const tokenFootprint = (actor: Pick<TokenView, 'size'>) => Math.max(.5, actor.size || 1);
export const tokenSideCells = (actor: Pick<TokenView, 'size'>, gridFeet = 5) => Math.max(1, Math.ceil(tokenFootprint(actor) * 5 / gridFeet));
export function tokenCells(actor: Pick<TokenView, 'size' | 'position'>, position = actor.position, gridFeet = 5): Position[] {
  return Array.from({ length: tokenSideCells(actor, gridFeet) ** 2 }, (_, index) => ({ x: position.x + index % tokenSideCells(actor, gridFeet), y: position.y + Math.floor(index / tokenSideCells(actor, gridFeet)) }));
}
export function tokenCentre(actor: Pick<TokenView, 'size' | 'position'>, position = actor.position, gridFeet = 5): Position {
  const offset = (tokenSideCells(actor, gridFeet) - 1) / 2; return { x: position.x + offset, y: position.y + offset };
}
const cross = (a: Position, b: Position, c: Position) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function intersects(a: Position, b: Position, c: Position, d: Position) {
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  if (x === 0 && y === 0) return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  return x * y <= 0 && z * w <= 0;
}
export function lineOfSight(scene: Scene, a: Position, b: Position) {
  return !scene.walls.some(wall => !(wall.door && wall.open) && intersects({ x: a.x + .5, y: a.y + .5 }, { x: b.x + .5, y: b.y + .5 }, wall.a, wall.b));
}
function canOccupy(scene: Scene, actor: TokenView, position: Position, actors: TokenView[]) {
  const cells = tokenCells(actor, position, scene.gridFeet), side = tokenSideCells(actor, scene.gridFeet);
  if (position.x < 0 || position.y < 0 || position.x + side > scene.width || position.y + side > scene.height) return false;
  if (actors.some(other => other.id !== actor.id && !other.dead && tokenCells(other, other.position, scene.gridFeet).some(cell => cells.some(point => cell.x === point.x && cell.y === point.y)))) return false;
  return cells.every(cell => (cell.x >= position.x + side - 1 || lineOfSight(scene, cell, { x: cell.x + 1, y: cell.y })) && (cell.y >= position.y + side - 1 || lineOfSight(scene, cell, { x: cell.x, y: cell.y + 1 })));
}
export function routeCost(scene: Scene, actor: TokenView, path: Position[]): number {
  return path.reduce((total, position) => total + 1 + Number(actor.conditions.includes('prone')) + Number(tokenCells(actor, position, scene.gridFeet).some(point => scene.terrain.some(terrain => terrain.type === 'difficult' && point.x >= terrain.x && point.y >= terrain.y && point.x < terrain.x + terrain.width && point.y < terrain.y + terrain.height))), 0);
}
/** Client-only route preview. The server independently validates movement and AP. */
export function pathBetween(from: Position, to: Position, scene: Scene, _unused: Position[] = [], options: { actor: TokenView; actors: TokenView[]; crawling?: boolean }): Position[] {
  if (![from.x, from.y, to.x, to.y].every(Number.isInteger) || !canOccupy(scene, options.actor, to, options.actors)) return [];
  const key = (point: Position) => `${point.x},${point.y}`, heuristic = (point: Position) => Math.max(Math.abs(point.x - to.x), Math.abs(point.y - to.y));
  const open = [from], costs = new Map([[key(from), 0]]), previous = new Map<string, Position>(); let visited = 0;
  while (open.length && visited++ <= Math.min(10000, scene.width * scene.height)) {
    open.sort((a, b) => (costs.get(key(a))! + heuristic(a)) - (costs.get(key(b))! + heuristic(b)));
    const current = open.shift()!;
    if (key(current) === key(to)) { const route = [current]; while (previous.has(key(route[0]))) route.unshift(previous.get(key(route[0]))!); return route.length <= 501 ? route : []; }
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue; const next = { x: current.x + dx, y: current.y + dy };
      if (!canOccupy(scene, options.actor, next, options.actors)) continue;
      const before = tokenCells(options.actor, current, scene.gridFeet), after = tokenCells(options.actor, next, scene.gridFeet);
      if (!before.every((cell, index) => lineOfSight(scene, cell, after[index]))) continue;
      const difficult = after.some(point => scene.terrain.some(terrain => terrain.type === 'difficult' && point.x >= terrain.x && point.y >= terrain.y && point.x < terrain.x + terrain.width && point.y < terrain.y + terrain.height));
      const nextCost = costs.get(key(current))! + 1 + Number(difficult) + Number(Boolean(options.crawling));
      if (nextCost >= (costs.get(key(next)) ?? Infinity)) continue;
      previous.set(key(next), current); costs.set(key(next), nextCost); if (!open.some(point => key(point) === key(next))) open.push(next);
    }
  }
  return [];
}
