import type { Actor, Position, Scene } from '../shared/model';
import { pathCost } from '../engine/map';
export function pathBetween(from: Position, to: Position, scene: Scene, occupied: Position[] = [], options: { crawling?: boolean; actor?: Actor; actors?: Actor[] } = {}): Position[] {
  if (!Number.isInteger(to.x) || !Number.isInteger(to.y) || to.x < 0 || to.y < 0 || to.x >= scene.width || to.y >= scene.height) return [];
  const key = (p: Position) => `${p.x},${p.y}`;
  const blocked = (a: Position, b: Position) => scene.walls.some(w => {
    if (w.door && w.open) return false;
    // Tokens occupy cells; walls lie along cell boundaries.
    const ax = a.x + .5, ay = a.y + .5, bx = b.x + .5, by = b.y + .5;
    const cross = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    return cross(ax, ay, bx, by, w.a.x, w.a.y) * cross(ax, ay, bx, by, w.b.x, w.b.y) <= 0 && cross(w.a.x, w.a.y, w.b.x, w.b.y, ax, ay) * cross(w.a.x, w.a.y, w.b.x, w.b.y, bx, by) <= 0 && Math.max(ax, bx) >= Math.min(w.a.x, w.b.x) && Math.min(ax, bx) <= Math.max(w.a.x, w.b.x) && Math.max(ay, by) >= Math.min(w.a.y, w.b.y) && Math.min(ay, by) <= Math.max(w.a.y, w.b.y);
  });
  const occupiedKeys = new Set(occupied.map(key)); occupiedKeys.delete(key(from));
  if (occupiedKeys.has(key(to))) return [];
  type Node = { point: Position; cost: number; priority: number };
  const pending: Node[] = []; const previous = new Map<string, Position | null>([[key(from), null]]); const costs = new Map([[key(from), 0]]);
  const push = (node: Node) => { pending.push(node); let index = pending.length - 1; while (index > 0) { const parent = (index - 1) >> 1; if (pending[parent].priority <= node.priority) break; pending[index] = pending[parent]; index = parent; } pending[index] = node; };
  const pop = () => { const first = pending[0]; const tail = pending.pop()!; if (pending.length) { let index = 0; while (index * 2 + 1 < pending.length) { let child = index * 2 + 1; if (child + 1 < pending.length && pending[child + 1].priority < pending[child].priority) child++; if (pending[child].priority >= tail.priority) break; pending[index] = pending[child]; index = child; } pending[index] = tail; } return first; };
  const estimate = (point: Position) => Math.max(Math.abs(point.x - to.x), Math.abs(point.y - to.y));
  push({ point: from, cost: 0, priority: estimate(from) });
  for (let index = 0; pending.length && index < 20000; index++) {
    const { point, cost } = pop(); if (cost !== costs.get(key(point))) continue;
    if (point.x === to.x && point.y === to.y) {
      const path = [point]; let current = previous.get(key(point));
      while (current) { path.unshift(current); current = previous.get(key(current)); }
      return path;
    }
    for (const delta of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 }]) {
      const next = { x: point.x + delta.x, y: point.y + delta.y };
      if (next.x < 0 || next.y < 0 || next.x >= scene.width || next.y >= scene.height || occupiedKeys.has(key(next)) || blocked(point, next)) continue;
      const difficult = scene.terrain.some(terrain => terrain.type === 'difficult' && next.x >= terrain.x && next.y >= terrain.y && next.x < terrain.x + terrain.width && next.y < terrain.y + terrain.height);
      let stepCost = 1 + (difficult ? 1 : 0) + (options.crawling ? 1 : 0);
      if (options.actor) {
        try { stepCost = pathCost(scene, { ...options.actor, position: point }, [next], options.actors || [], { crawling: options.crawling }) / scene.gridFeet; }
        catch { continue; }
      }
      const nextCost = cost + stepCost;
      if (nextCost >= (costs.get(key(next)) ?? Infinity)) continue;
      previous.set(key(next), point); costs.set(key(next), nextCost); push({ point: next, cost: nextCost, priority: nextCost + estimate(next) });
    }
  }
  return [];
}
