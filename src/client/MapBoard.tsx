import { useEffect, useRef, useState } from 'react';
import type { ActionDefinition, Actor, Position, Scene } from '../shared/model';
import { areaContains, resolveSpellArea } from '../shared/spell-geometry';
import { lineOfSight } from '../engine/map';
import { tokenCells, tokenCentre, tokenSideCells } from '../engine/spatial';
import { tokenFootprint } from '../engine/size';
import { MapFallback } from './MapFallback';
import { actorColor, actorInitial, pathBetween } from './client-utils';

export type MapTool = 'select' | 'move' | 'target' | 'pan' | 'wall' | 'door' | 'terrain' | 'erase' | 'area';
interface Props {
  scene: Scene; actors: Actor[]; selectedId: string; targetIds: string[]; gm: boolean; editableIds: string[];
  activeId?: string; onSelect: (id: string) => void; onTarget: (id: string) => void;
  onMove: (actor: Actor, path: Position[]) => void; onScene: (scene: Scene) => void;
  onOrigin: (position: Position) => void; origin?: Position; areaAction?: ActionDefinition; disabled?: boolean;
}
const CELL = 48;
const TOOLS: [MapTool, string, string][] = [['select', '↖', '选择'], ['move', '✥', '移动'], ['target', '◎', '目标'], ['pan', '✋', '平移'], ['area', '◌', '范围'], ['wall', '╱', '墙体'], ['door', '▯', '门'], ['terrain', '▧', '地形'], ['erase', '⌫', '擦除']];
export function MapBoard(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<MapTool>('select');
  const [camera, setCamera] = useState({ x: 28, y: 28, zoom: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const cameraReady = useRef(false); const actorFocused = useRef(false);
  const [first, setFirst] = useState<Position | null>(null);
  const [hover, setHover] = useState<Position | null>(null);
  const [renderer, setRenderer] = useState<any>(null);
  const [renderError, setRenderError] = useState(false);
  const [backgroundFailure, setBackgroundFailure] = useState<string>();
  const [portraitFailures, setPortraitFailures] = useState<Record<string, string>>({});
  // The server projects visibility; retain the same boundary before requesting any image.
  const visibleActors = props.actors.filter(actor => props.gm || !actor.hidden);
  const [terrainType, setTerrainType] = useState<'difficult' | 'half-cover' | 'three-quarter-cover'>('difficult');
  const [hint, setHint] = useState('选择一名角色，点击空地规划移动。');
  const pointer = useRef<{ x: number; y: number; camX: number; camY: number; moved: boolean; pan: boolean; actor?: Actor; anchorOffset?: Position } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const latest = useRef(props); latest.current = props;
  const actorAt = (point: Position) => visibleActors.find(actor => tokenCells(actor, actor.position, props.scene.gridFeet).some(cell => cell.x === point.x && cell.y === point.y));
  const routeFor = (actor: Actor, destination: Position) => pathBetween(actor.position, destination, props.scene, [], { actor, actors: visibleActors, crawling: actor.effects.some(effect => effect.condition === 'prone') });
  const moveActor = (actor: Actor, destination: Position) => {
    if (props.disabled) return;
    const path = routeFor(actor, destination);
    if (!path.length) { setHint('这里没有能容纳整枚棋子的路径；请检查占位、边界、墙与门。'); return; }
    if (path.length > 1) props.onMove(actor, path.slice(1));
  };
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0].contentRect;
      setSize({ width: Math.max(1, box.width), height: Math.max(1, box.height) });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false; let application: any;
    void import('pixi.js').then(async PIXI => {
      // Pixi's CSP polyfill replaces generated shader/uniform functions without eval.
      await import('pixi.js/unsafe-eval');
      // Use HTMLImageElement under img-src. Workers and fetch(data:) are intentionally
      // disallowed by production CSP; disabling only workers still takes the fetch path.
      PIXI.Assets.setPreferences({ preferWorkers: false, preferCreateImageBitmap: false });
      application = new PIXI.Application();
      await application.init({ background: '#141922', antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, width: Math.max(1, host.current?.clientWidth || 800), height: Math.max(1, host.current?.clientHeight || 600), preference: 'webgl', preserveDrawingBuffer: true, autoStart: false });
      if (disposed) { application.destroy(true, { children: true }); return; }
      application.canvas.setAttribute('aria-hidden', 'true'); host.current?.prepend(application.canvas);
      setRenderer({ app: application, PIXI });
    }).catch(error => { if (!disposed) { console.warn('地图图形初始化失败，启用兼容绘制。', error); setRenderError(true); } });
    return () => { disposed = true; if (application?.renderer) application.destroy(true, { children: true }); };
  }, []);
  useEffect(() => {
    if (!renderer) return;
    const redraw = () => { if (document.visibilityState === 'visible' && renderer.app.stage && !renderer.app.stage.destroyed) renderer.app.render(); };
    document.addEventListener('visibilitychange', redraw);
    return () => document.removeEventListener('visibilitychange', redraw);
  }, [renderer]);
  useEffect(() => {
    if (!renderer || size.width < 1 || size.height < 1) return;
    const { app, PIXI } = renderer;
    if (app.screen.width !== size.width || app.screen.height !== size.height) app.renderer.resize(size.width, size.height);
    app.stage.removeChildren().forEach((child: any) => child.destroy({ children: true }));
    const board = new PIXI.Container(); board.position.set(camera.x, camera.y); board.scale.set(camera.zoom); app.stage.addChild(board);
    const floor = new PIXI.Graphics();
    floor.roundRect(0, 0, props.scene.width * CELL, props.scene.height * CELL, 3).fill('#1b222c');
    for (let x = 0; x < props.scene.width; x++) for (let y = 0; y < props.scene.height; y++) {
      if ((x + y) % 2 === 0) floor.rect(x * CELL, y * CELL, CELL, CELL).fill({ color: '#a7b4c8', alpha: .025 });
    }
    board.addChild(floor);
    let disposed = false;
    if (props.scene.background && /^(https?:|data:image\/)/i.test(props.scene.background)) {
      void PIXI.Assets.load({ src: props.scene.background, parser: 'texture' }).then((texture: any) => {
        if (disposed || board.destroyed) return;
        setBackgroundFailure(undefined);
        const background = new PIXI.Sprite(texture); background.width = props.scene.width * CELL; background.height = props.scene.height * CELL; background.alpha = .8; board.addChildAt(background, 1); app.render();
      }).catch(() => { if (!disposed && !board.destroyed) setBackgroundFailure(props.scene.background); });
    }
    const grid = new PIXI.Graphics();
    for (let x = 0; x <= props.scene.width; x++) grid.moveTo(x * CELL, 0).lineTo(x * CELL, props.scene.height * CELL);
    for (let y = 0; y <= props.scene.height; y++) grid.moveTo(0, y * CELL).lineTo(props.scene.width * CELL, y * CELL);
    grid.stroke({ color: '#b1becd', alpha: .11, width: 1 / camera.zoom }); board.addChild(grid);
    const terrain = new PIXI.Graphics();
    for (const part of props.scene.terrain) terrain.rect(part.x * CELL, part.y * CELL, part.width * CELL, part.height * CELL).fill({ color: part.type === 'difficult' ? '#b59760' : '#88a5bb', alpha: .2 }).stroke({ color: part.type === 'difficult' ? '#b59760' : '#88a5bb', alpha: .5, width: 1 });
    board.addChild(terrain);
    const walls = new PIXI.Graphics();
    for (const wall of props.scene.walls) {
      walls.moveTo(wall.a.x * CELL, wall.a.y * CELL).lineTo(wall.b.x * CELL, wall.b.y * CELL).stroke({ color: wall.door ? (wall.open ? '#85b995' : '#d5aa6d') : '#a5b1bb', alpha: wall.open ? .35 : 1, width: wall.door ? 5 : 6, cap: 'round' });
    }
    board.addChild(walls);
    if (props.scene.fog && props.gm) {
      const fog = new PIXI.Graphics().rect(0, 0, props.scene.width * CELL, props.scene.height * CELL).fill({ color: '#778eaf', alpha: .055 }); board.addChild(fog);
    } else if (props.scene.fog) {
      const observers = visibleActors.filter(actor => props.editableIds.includes(actor.id) && !actor.dead && !actor.effects.some(effect => ['blinded', 'unconscious'].includes(effect.condition || '')));
      const fog = new PIXI.Graphics();
      for (let x = 0; x < props.scene.width; x++) for (let y = 0; y < props.scene.height; y++) if (!observers.some(actor => lineOfSight(props.scene, actor.position, { x, y }))) fog.rect(x * CELL, y * CELL, CELL + .5, CELL + .5).fill({ color: '#0b1019', alpha: .97 });
      board.addChild(fog);
    }
    const selected = visibleActors.find(actor => actor.id === props.selectedId);
    if (hover && selected && (tool === 'move' || tool === 'select') && props.editableIds.includes(selected.id)) {
      const path = routeFor(selected, hover);
      const preview = new PIXI.Graphics();
      const footprint = tokenSideCells(selected, props.scene.gridFeet) * CELL;
      path.forEach(point => preview.roundRect(point.x * CELL + 4, point.y * CELL + 4, footprint - 8, footprint - 8, 8).fill({ color: '#c9b07e', alpha: .12 }));
      board.addChild(preview);
    }
    if (props.origin && props.areaAction?.area && selected) {
      const area = resolveSpellArea(props.areaAction, selected.position, { origin: props.origin }, props.scene.gridFeet);
      const range = new PIXI.Graphics();
      for (let x = 0; x < props.scene.width; x++) for (let y = 0; y < props.scene.height; y++) if (areaContains(area, { x, y })) range.rect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4).fill({ color: '#b398dd', alpha: .18 });
      const ox = (area.origin.x + .5) * CELL, oy = (area.origin.y + .5) * CELL, length = area.size / area.gridFeet * CELL;
      if (area.shape === 'sphere' || area.shape === 'cylinder') range.circle(ox, oy, length).stroke({ color: '#c7acec', alpha: .8, width: 2 });
      else {
        const norm = Math.hypot(area.direction.x, area.direction.y), dx = norm ? area.direction.x / norm : 1, dy = norm ? area.direction.y / norm : 0;
        const ex = ox + dx * length, ey = oy + dy * length;
        const halfWidth = area.shape === 'line' ? (area.width || 5) / area.gridFeet * CELL / 2 : length / 2;
        range.poly(area.shape === 'cone' ? [ox, oy, ex - dy * halfWidth, ey + dx * halfWidth, ex + dy * halfWidth, ey - dx * halfWidth] : [ox - dy * halfWidth, oy + dx * halfWidth, ex - dy * halfWidth, ey + dx * halfWidth, ex + dy * halfWidth, ey - dx * halfWidth, ox + dy * halfWidth, oy - dx * halfWidth]).stroke({ color: '#c7acec', alpha: .8, width: 2 });
      }
      board.addChild(range);
    }
    if (first && hover) {
      const guide = new PIXI.Graphics();
      if (tool === 'terrain') guide.rect(Math.min(first.x, hover.x) * CELL, Math.min(first.y, hover.y) * CELL, (Math.abs(first.x - hover.x) + 1) * CELL, (Math.abs(first.y - hover.y) + 1) * CELL).fill({ color: '#c5a77a', alpha: .25 });
      else guide.moveTo(first.x * CELL, first.y * CELL).lineTo(hover.x * CELL, hover.y * CELL).stroke({ color: '#e8cf9a', width: 4 });
      board.addChild(guide);
    }
    for (const actor of visibleActors) {
      const { x, y } = actor.position; const side = tokenSideCells(actor, props.scene.gridFeet); const centre = tokenCentre(actor, actor.position, props.scene.gridFeet);
      const radius = CELL * (side > 1 ? .43 * side : tokenFootprint(actor) < 1 ? .22 : .34);
      if (side > 1) { const footprint = new PIXI.Graphics().roundRect(x * CELL + 2, y * CELL + 2, side * CELL - 4, side * CELL - 4, 5).fill({ color: actorColor(actor.id), alpha: .06 }).stroke({ color: actor.id === props.selectedId ? '#f6e3b8' : actorColor(actor.id), alpha: actor.hidden ? .25 : .6, width: 1.5 }); board.addChild(footprint); }
      const token = new PIXI.Container(); token.position.set((centre.x + .5) * CELL, (centre.y + .5) * CELL); token.alpha = actor.hidden ? .45 : 1;
      const color = actorColor(actor.id); const glyph = new PIXI.Graphics();
      glyph.circle(2, 4, radius + 2).fill({ color: '#05090f', alpha: .6 });
      if (actor.id === props.activeId) glyph.circle(0, 0, radius + 7).stroke({ color: '#d5bb84', width: 1.5, alpha: .8 });
      if (actor.id === props.selectedId) glyph.circle(0, 0, radius + 4).stroke({ color: '#f6e3b8', width: 2.5 });
      glyph.circle(0, 0, radius + 1).stroke({ color: actorColor(actor.ownerId || actor.id), width: 3 });
      glyph.circle(0, 0, radius).fill(actor.kind === 'monster' ? '#533d43' : '#2c4142').stroke({ color, width: 2 });
      if (props.targetIds.includes(actor.id)) {
        glyph.circle(0, 0, radius + 10).stroke({ color: '#df8d8d', width: 2 });
        glyph.moveTo(-radius - 15, 0).lineTo(-radius - 5, 0).moveTo(radius + 5, 0).lineTo(radius + 15, 0).stroke({ color: '#df8d8d', width: 2 });
      }
      token.addChild(glyph);
      const label = new PIXI.Text({ text: actorInitial(actor), style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 16, fontWeight: '600', fill: color } }); label.anchor.set(.5); token.addChild(label);
      if (actor.portrait && /^(https?:|data:image\/)/i.test(actor.portrait)) {
        const source = actor.portrait;
        void PIXI.Assets.load({ src: source, parser: 'texture' }).then((texture: any) => {
          if (disposed || token.destroyed || board.destroyed) return;
          if (!(texture.width > 0 && texture.height > 0)) throw new Error('Portrait image has no drawable pixels');
          const face = new PIXI.Container(), image = new PIXI.Sprite(texture);
          const innerRadius = Math.max(1, radius - 2);
          image.anchor.set(.5); image.scale.set(Math.max(innerRadius * 2 / texture.width, innerRadius * 2 / texture.height));
          const mask = new PIXI.Graphics().circle(0, 0, innerRadius).fill('#ffffff');
          face.addChild(image, mask); image.mask = mask;
          // Portrait stays inside the identity/ownership rings; captions and HP stay on top.
          token.addChildAt(face, 1); label.visible = false; app.render();
          setPortraitFailures(previous => { if (!(actor.id in previous)) return previous; const next = { ...previous }; delete next[actor.id]; return next; });
        }).catch(() => { if (!disposed && !token.destroyed && !board.destroyed) setPortraitFailures(previous => previous[actor.id] === source ? previous : { ...previous, [actor.id]: source }); });
      }
      const name = new PIXI.Text({ text: actor.name.slice(0, 10), style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 10, fill: '#d6dce3', dropShadow: { color: '#000000', blur: 3, distance: 0 } } }); name.anchor.set(.5, 0); name.y = radius + 7; token.addChild(name);
      const hp = new PIXI.Graphics().roundRect(-radius, radius + 21, radius * 2, 3, 1).fill('#0d131a'); hp.roundRect(-radius, radius + 21, Math.max(0, Math.min(1, actor.hp.current / Math.max(1, actor.hp.max))) * radius * 2, 3, 1).fill(actor.hp.current < actor.hp.max * .3 ? '#dd8d84' : '#92baa0'); token.addChild(hp); board.addChild(token);
    }
    app.render();
    return () => { disposed = true; };
  }, [renderer, props.scene, props.actors, props.selectedId, props.targetIds, props.activeId, props.origin, props.areaAction, props.gm, camera, size, hover, tool, first]);
  const pointAt = (clientX: number, clientY: number, edge = false): Position => {
    const box = host.current!.getBoundingClientRect(); const x = (clientX - box.left - camera.x) / (CELL * camera.zoom), y = (clientY - box.top - camera.y) / (CELL * camera.zoom);
    return { x: Math.max(0, Math.min(props.scene.width - (edge ? 0 : 1), edge ? Math.round(x) : Math.floor(x))), y: Math.max(0, Math.min(props.scene.height - (edge ? 0 : 1), edge ? Math.round(y) : Math.floor(y))) };
  };
  const activate = (position: Position) => {
    if (props.disabled) return;
    const actor = actorAt(position);
    if (tool === 'target') { if (actor) props.onTarget(actor.id); return; }
    if (tool === 'area') { props.onOrigin(position); setHint(`范围原点：${position.x + 1}, ${position.y + 1}`); return; }
    if (props.gm && ['wall', 'door', 'terrain'].includes(tool)) {
      if (tool === 'door') {
        const door = props.scene.walls.find(row => row.door && Math.abs((row.a.x + row.b.x) / 2 - position.x) < 1 && Math.abs((row.a.y + row.b.y) / 2 - position.y) < 1);
        if (door && !first) { props.onScene({ ...props.scene, walls: props.scene.walls.map(row => row.id === door.id ? { ...row, open: !row.open } : row) }); return; }
      }
      if (!first) { setFirst(position); setHint('再点击终点完成绘制；按 Esc 取消。'); return; }
      if (first.x === position.x && first.y === position.y && tool !== 'terrain') { setFirst(null); return; }
      if (tool === 'terrain') props.onScene({ ...props.scene, terrain: [...props.scene.terrain, { id: crypto.randomUUID(), x: Math.min(first.x, position.x), y: Math.min(first.y, position.y), width: Math.abs(first.x - position.x) + 1, height: Math.abs(first.y - position.y) + 1, type: terrainType }] });
      else props.onScene({ ...props.scene, walls: [...props.scene.walls, { id: crypto.randomUUID(), a: first, b: position, door: tool === 'door', open: false }] });
      setFirst(null); return;
    }
    if (props.gm && tool === 'erase') {
      props.onScene({ ...props.scene, walls: props.scene.walls.filter(row => !(Math.min(row.a.x, row.b.x) - .5 <= position.x && Math.max(row.a.x, row.b.x) + .5 >= position.x && Math.min(row.a.y, row.b.y) - .5 <= position.y && Math.max(row.a.y, row.b.y) + .5 >= position.y)), terrain: props.scene.terrain.filter(row => !(position.x >= row.x && position.y >= row.y && position.x < row.x + row.width && position.y < row.y + row.height)) }); return;
    }
    if (actor && tool !== 'pan') { props.onSelect(actor.id); return; }
    const selected = visibleActors.find(row => row.id === props.selectedId);
    if (selected && props.editableIds.includes(selected.id) && (tool === 'move' || tool === 'select')) {
      moveActor(selected, position);
    }
  };
  const fit = () => { const zoom = Math.max(.25, Math.min(1.5, (size.width - 60) / (props.scene.width * CELL), (size.height - 60) / (props.scene.height * CELL))); setCamera({ x: (size.width - props.scene.width * CELL * zoom) / 2, y: (size.height - props.scene.height * CELL * zoom) / 2, zoom }); };
  useEffect(() => {
    if (size.width < 1 || size.height < 1) return;
    const focus = visibleActors.find(actor => actor.id === props.selectedId) || visibleActors[0];
    if (focus && !actorFocused.current) { const zoom = size.width < 600 ? .8 : 1; const centre = tokenCentre(focus, focus.position, props.scene.gridFeet); setCamera({ x: Math.min(24, size.width / 2 - (centre.x + .5) * CELL * zoom), y: Math.min(80, size.height / 2 - (centre.y + .5) * CELL * zoom), zoom }); actorFocused.current = true; cameraReady.current = true; }
    else if (!cameraReady.current) { fit(); cameraReady.current = true; }
  }, [props.scene.width, props.scene.height, size.width, size.height, Boolean(visibleActors.length)]);
  return <div className="map-shell">
    <div className="map-toolbar" role="toolbar" aria-label="地图工具">
      {TOOLS.filter(([id]) => props.gm || !['wall', 'door', 'terrain', 'erase'].includes(id)).map(([id, icon, label]) => <button key={id} className={`map-tool ${tool === id ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={tool === id} onClick={() => { setTool(id); setFirst(null); setHint(id === 'wall' || id === 'door' ? '依次点击网格边上的起点、终点。门工具可点击已有门切换开闭。' : id === 'terrain' ? '点击区域的两个对角格设置地形。' : id === 'target' ? '点击棋子选择或取消行动目标。' : id === 'area' ? '点击地图设置法术范围原点。' : '拖动棋子移动，或选择角色后点击空地。'); }}><span>{icon}</span><small>{label}</small></button>)}
      {tool === 'terrain' && <select aria-label="地形类型" value={terrainType} onChange={event => setTerrainType(event.target.value as typeof terrainType)}><option value="difficult">困难地形</option><option value="half-cover">半身掩护</option><option value="three-quarter-cover">四分之三掩护</option></select>}
    </div>
    <div ref={host} className={`battle-map tool-${tool}`} tabIndex={0} role="application" aria-label="二维战术地图；方向键移动所选角色，Shift加方向键平移，Escape取消绘制" onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if ((event.target as Element).closest('button,input,select,textarea,a')) { pointer.current = null; return; }
        event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 2) { const values = [...pointers.current.values()]; pinch.current = { distance: Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y), zoom: camera.zoom }; return; }
        const point = pointAt(event.clientX, event.clientY); const actor = actorAt(point);
        const movable = actor && props.editableIds.includes(actor.id) && ['select', 'move'].includes(tool) ? actor : undefined;
        pointer.current = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y, moved: false, pan: tool === 'pan' || event.button === 2 || event.shiftKey, actor: movable, anchorOffset: movable ? { x: point.x - movable.position.x, y: point.y - movable.position.y } : undefined };
        if (movable && !pointer.current.pan) props.onSelect(movable.id);
      }}
      onPointerMove={event => {
        if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size >= 2 && pinch.current) { const values = [...pointers.current.values()]; const zoom = Math.max(.25, Math.min(3, pinch.current.zoom * Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) / Math.max(1, pinch.current.distance))); setCamera(previous => ({ ...previous, zoom })); return; }
        const hoverPoint = pointAt(event.clientX, event.clientY, tool === 'wall' || tool === 'door'); const grab = pointer.current;
        setHover(grab?.actor && grab.anchorOffset && !grab.pan ? { x: hoverPoint.x - grab.anchorOffset.x, y: hoverPoint.y - grab.anchorOffset.y } : hoverPoint);
        const down = pointer.current; if (!down) return;
        const dx = event.clientX - down.x, dy = event.clientY - down.y; if (Math.hypot(dx, dy) > 6) down.moved = true;
        if (down.pan) setCamera(previous => ({ ...previous, x: down.camX + dx, y: down.camY + dy }));
      }}
      onPointerUp={event => {
        pointers.current.delete(event.pointerId); if (pinch.current) { if (pointers.current.size === 0) pinch.current = null; pointer.current = null; return; }
        const down = pointer.current; pointer.current = null;
        if (down?.actor && down.moved && !down.pan && !props.disabled) { const point = pointAt(event.clientX, event.clientY); moveActor(down.actor, { x: point.x - (down.anchorOffset?.x || 0), y: point.y - (down.anchorOffset?.y || 0) }); }
        else if (down && !down.moved && !down.pan) activate(pointAt(event.clientX, event.clientY, tool === 'wall' || tool === 'door'));
      }} onPointerCancel={() => { pointer.current = null; pointers.current.clear(); pinch.current = null; }} onPointerLeave={() => { if (!pointer.current) setHover(null); }}
      onWheel={event => { const box = event.currentTarget.getBoundingClientRect(); const x = event.clientX - box.left, y = event.clientY - box.top; setCamera(previous => { const zoom = Math.max(.25, Math.min(3, previous.zoom * (event.deltaY > 0 ? .9 : 1.1))); return { x: x - (x - previous.x) * zoom / previous.zoom, y: y - (y - previous.y) * zoom / previous.zoom, zoom }; }); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setFirst(null); return; }
        const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key]; if (!direction) return;
        event.preventDefault(); const selected = visibleActors.find(row => row.id === props.selectedId);
        if (event.shiftKey) setCamera(previous => ({ ...previous, x: previous.x - direction[0] * 32, y: previous.y - direction[1] * 32 }));
        else if (selected && props.editableIds.includes(selected.id)) moveActor(selected, { x: selected.position.x + direction[0], y: selected.position.y + direction[1] });
      }}>
      {renderError && <MapFallback scene={props.scene} actors={visibleActors} selectedId={props.selectedId} activeId={props.activeId} targetIds={props.targetIds} gm={props.gm} editableIds={props.editableIds} camera={camera} onBackgroundResult={(source, loaded) => { if (latest.current.scene.background === source) setBackgroundFailure(loaded ? undefined : source); }} onPortraitResult={(id, source, loaded) => {
        if (!latest.current.actors.some(actor => actor.id === id && actor.portrait === source && (latest.current.gm || !actor.hidden))) return;
        setPortraitFailures(previous => { if (!loaded) return previous[id] === source ? previous : { ...previous, [id]: source }; if (!(id in previous)) return previous; const next = { ...previous }; delete next[id]; return next; });
      }} />}
      {!visibleActors.length && <div className="map-empty"><span>✧</span><h3>每段冒险，都从这里开始</h3><p>{props.gm ? '创建角色或从怪物图鉴加入遭遇。' : '创建你的第一名角色，踏入冒险。'}</p></div>}
      <div className="map-coordinates">{hover ? `${hover.x + 1} : ${hover.y + 1}` : 'TACTICAL VIEW'}<span>{props.scene.gridFeet} 尺 / 格</span></div>
      <div className="map-zoom"><button aria-label="缩小地图" onClick={() => setCamera(previous => ({ ...previous, zoom: Math.max(.25, previous.zoom / 1.2) }))}>−</button><button onClick={fit} title="适应画布">{Math.round(camera.zoom * 100)}%</button><button aria-label="放大地图" onClick={() => setCamera(previous => ({ ...previous, zoom: Math.min(3, previous.zoom * 1.2) }))}>＋</button></div>
    </div>
    <div className="map-status"><span className="status-dot" />{hint}{visibleActors.some(actor => actor.portrait && portraitFailures[actor.id] === actor.portrait) && <span role="status">部分角色头像加载失败，已保留文字棋子。</span>}{backgroundFailure && backgroundFailure === props.scene.background && <span role="alert">背景图片加载失败；请检查图片地址与跨域权限，或重新上传本地图片。地图和棋子仍可使用。</span>}<span className="map-renderer">{renderError ? '兼容渲染' : 'PixiJS'} · {props.scene.width} × {props.scene.height}</span></div>
  </div>;
}
