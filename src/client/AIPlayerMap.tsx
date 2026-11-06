import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AiDisplayEntity, AiMapView } from '../shared/ai-display';
import { AI_AVATAR_RADIUS, AI_LANDMARK_RADIUS, DEFAULT_AI_MAP_FRAME, aiNameInitial, boundedMapZoom, finiteMapPoint, focusAiMap, hitMapCircle, mapFrame, mapImageSource, mapScreenToWorld, mapWorldToScreen, normalizedToWorld, worldToNormalized, zoomMapAt, type AiMapCamera, type AiMapPoint } from './ai-map-geometry';
import './ai-player-map.css';

export interface AIPlayerMapProps {
  /** Already projected by the server. Never pass the owner snapshot to a player. */
  entities: readonly AiDisplayEntity[]; ownPcId?: string; map?: AiMapView;
  onEntityClick: (id: string) => void;
  /** A destination suggestion for the behavior editor, not an authoritative move. */
  onMoveIntent?: (position: AiMapPoint) => void;
  canPlaceLandmarks?: boolean;
  onPlaceLandmark?: (id: string, position: AiMapPoint | null) => Promise<boolean> | boolean;
  pending?: boolean; error?: string; className?: string;
}
interface ScreenEntity { entity: AiDisplayEntity; screen: AiMapPoint; radius: number }
const shortName = (name: string) => Array.from(name).slice(0, 14).join('');
const color = (entity: AiDisplayEntity, own: boolean) => own ? '#e5c28a' : entity.kind === 'enemy' ? '#da9697' : entity.kind === 'landmark' ? '#b4c7dc' : entity.kind === 'item' ? '#c9b18b' : '#9fc9c1';
const landmarkType = (entity: AiDisplayEntity) => typeof entity.fields.landmarkType?.value === 'string' ? entity.fields.landmarkType.value : 'other';
const landmarkNames: Record<string, string> = { location: '地点', door: '门', trap: '陷阱', container: '容器', object: '物件', other: '地标' };
function LandmarkGlyph({ type }: { type: string }) {
  if (type === 'door') return <><path d="M-7 10V-11H7v21M-10 10h20" /><circle cx="3" cy="0" r=".8" fill="currentColor" /></>;
  if (type === 'container') return <><path d="M-10-4h20v13h-20zM-10-4l3-5H7l3 5M0-4v13" /><path d="M-3 0h6v4h-6z" /></>;
  if (type === 'trap') return <><path d="M0-11 11 9H-11Z" /><path d="M0-4v6M0 6v.5" /></>;
  if (type === 'object') return <path d="M0-11 10 0 0 11-10 0Z" />;
  return <><path d="M0 12s-8-9-8-15a8 8 0 0 1 16 0c0 6-8 15-8 15Z" /><circle cy="-3" r="2.5" /></>;
}
function MapIdentity({ value, own, onOpen }: { value: ScreenEntity; own: boolean; onOpen: () => void }) {
  const { entity, screen, radius } = value, [failed, setFailed] = useState('');
  const source = mapImageSource(entity.image), label = entity.kind === 'landmark' ? `查看地标：${entity.name}` : own ? `查看我的角色：${entity.name}` : `查看${entity.name}的公开资料`;
  return <button type="button" className={`ai-map-identity ${own ? 'is-own' : ''}`} data-ai-map-entity={entity.id} data-ai-map-kind={entity.kind} data-screen-x={screen.x} data-screen-y={screen.y} style={{ left: screen.x, top: screen.y, width: radius * 2, height: radius * 2, color: color(entity, own) }} aria-label={label} title={entity.name} onClick={event => { if (event.detail === 0) onOpen(); }}>
    <span className="ai-map-identity-face" data-avatar-hit-circle="true">
      {entity.kind === 'landmark' ? <svg width="25" height="25" viewBox="-16 -16 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><LandmarkGlyph type={landmarkType(entity)} /></svg> : source && failed !== source ? <img src={source} alt="" onError={() => setFailed(source)} /> : <span className="ai-map-initial">{aiNameInitial(entity.name)}</span>}
    </span><span className="ai-map-name">{shortName(entity.name)}</span>
  </button>;
}
function MapControlIcon({ kind }: { kind: 'focus' | 'players' | 'landmarks' }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'focus' ? <><circle cx="12" cy="12" r="6" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="1" fill="currentColor" /></> : kind === 'players' ? <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m0-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4" /></> : <><path d="M12 22s8-9 8-14A8 8 0 0 0 4 8c0 5 8 14 8 14Z" /><circle cx="12" cy="8" r="2.5" /></>}</svg>;
}

/** AI display v2 map: all numbers are presentation coordinates, never engine state. */
export function AIPlayerMap(props: AIPlayerMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null), instruction = useId();
  const [viewport, setViewport] = useState({ width: 0, height: 0 }), [camera, setCamera] = useState<AiMapCamera>({ x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const [hideOtherPlayers, setHideOtherPlayers] = useState(false), [showLandmarks, setShowLandmarks] = useState(true), [message, setMessage] = useState('');
  const [backgroundError, setBackgroundError] = useState(''), [selectedLandmark, setSelectedLandmark] = useState(''), [placing, setPlacing] = useState(false), [candidate, setCandidate] = useState<AiMapPoint>(), [saving, setSaving] = useState(false);
  const own = props.entities.find(entity => entity.id === props.ownPcId && entity.kind === 'pc');
  const explicitFrame = mapFrame(props.map), frame = explicitFrame || DEFAULT_AI_MAP_FRAME, image = mapImageSource(props.map?.image);
  const landmarks = props.entities.filter(entity => entity.kind === 'landmark');
  const chosenLandmark = landmarks.find(entity => entity.id === selectedLandmark);
  const pending = Boolean(props.pending || saving);
  const changeCamera = (value: AiMapCamera) => { cameraRef.current = value; setCamera(value); };
  const worldPosition = (entity: AiDisplayEntity): AiMapPoint | undefined => {
    const point = finiteMapPoint(entity.position) ? normalizedToWorld(entity.position, frame) : entity.id === own?.id ? { x: frame.width / 2, y: frame.height / 2 } : undefined;
    return finiteMapPoint(point) ? point : undefined;
  };
  const returnToOwn = () => {
    const point = own ? worldPosition(own) : undefined;
    changeCamera(focusAiMap(frame, viewport, point || { x: frame.width / 2, y: frame.height / 2 })); setMessage('');
  };
  useEffect(() => {
    const element = viewportRef.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewportRef.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); const box = element.getBoundingClientRect(), point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      changeCamera(zoomMapAt(cameraRef.current, point, cameraRef.current.zoom * Math.exp(-Math.max(-300, Math.min(300, delta)) * .002)));
    };
    const retryImage = () => setBackgroundError('');
    element.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('online', retryImage);
    return () => { element.removeEventListener('wheel', wheel); window.removeEventListener('online', retryImage); };
  }, []);
  const previousView = useRef<{ width: number; height: number; own?: string; image?: string; mapWidth: number; mapHeight: number } | undefined>(undefined);
  useEffect(() => {
    if (viewport.width < 1 || viewport.height < 1) return;
    const previous = previousView.current;
    if (!previous || previous.own !== own?.id || previous.image !== props.map?.image || previous.mapWidth !== frame.width || previous.mapHeight !== frame.height) returnToOwn();
    else if (previous.width !== viewport.width || previous.height !== viewport.height) changeCamera({ ...cameraRef.current, x: cameraRef.current.x + (viewport.width - previous.width) / 2, y: cameraRef.current.y + (viewport.height - previous.height) / 2 });
    previousView.current = { ...viewport, own: own?.id, image: props.map?.image, mapWidth: frame.width, mapHeight: frame.height };
  }, [viewport.width, viewport.height, own?.id, props.map?.image, frame.width, frame.height]);
  useEffect(() => { if (selectedLandmark && !chosenLandmark) { setSelectedLandmark(''); setPlacing(false); setCandidate(undefined); } }, [selectedLandmark, Boolean(chosenLandmark)]);
  const screenEntities = useMemo(() => {
    const visible = props.entities.filter(entity => entity.kind === 'landmark' ? showLandmarks && finiteMapPoint(entity.position) : !(hideOtherPlayers && entity.kind === 'pc' && entity.id !== own?.id));
    // Own identity is painted and hit-tested last when markers overlap.
    visible.sort((a, b) => Number(a.id === own?.id) - Number(b.id === own?.id));
    return visible.flatMap(entity => { const point = worldPosition(entity); if (!point) return []; const screen = mapWorldToScreen(point, camera); if (!finiteMapPoint(screen)) return []; return [{ entity, screen, radius: entity.kind === 'landmark' || entity.kind === 'item' ? AI_LANDMARK_RADIUS : AI_AVATAR_RADIUS }]; });
  }, [props.entities, own?.id, frame.width, frame.height, camera, hideOtherPlayers, showLandmarks]);
  const latest = useRef({ screenEntities, explicitFrame, frame, placing, chosenLandmark, pending, onMoveIntent: props.onMoveIntent, onEntityClick: props.onEntityClick }); latest.current = { screenEntities, explicitFrame, frame, placing, chosenLandmark, pending, onMoveIntent: props.onMoveIntent, onEntityClick: props.onEntityClick };
  const localPoint = (clientX: number, clientY: number): AiMapPoint => { const box = viewportRef.current!.getBoundingClientRect(); return { x: clientX - box.left, y: clientY - box.top }; };
  const pointers = useRef(new Map<number, AiMapPoint>()), gesture = useRef<{ start: AiMapPoint; camera: AiMapCamera; moved: boolean; button: number } | undefined>(undefined), pinch = useRef<{ distance: number; anchor: AiMapPoint; camera: AiMapCamera } | undefined>(undefined), suppressTap = useRef(false), lastTap = useRef<{ time: number; point: AiMapPoint } | undefined>(undefined), lastSuggestion = useRef(0);
  const suggestDestination = (point: AiMapPoint) => {
    if (!latest.current.onMoveIntent || !latest.current.explicitFrame || hitMapCircle(latest.current.screenEntities, point) || latest.current.placing || Date.now() - lastSuggestion.current < 450) return;
    const value = worldToNormalized(mapScreenToWorld(point, cameraRef.current), latest.current.frame); if (!finiteMapPoint(value)) return;
    lastSuggestion.current = Date.now(); latest.current.onMoveIntent(value); setMessage('目标位置已带入行动草稿，提交后才交给AI处理。');
  };
  const savePlacement = async (position: AiMapPoint | null) => {
    if (!chosenLandmark || !props.onPlaceLandmark || pending) return; setSaving(true); setMessage('');
    try { if (await props.onPlaceLandmark(chosenLandmark.id, position)) { setPlacing(false); setCandidate(undefined); setMessage(position ? '地标位置已由服务器确认。' : '地标坐标已移除。'); } else setMessage('地标位置尚未保存。请处理提示后重试。'); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : '地标位置保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  const ghost = candidate ? mapWorldToScreen(normalizedToWorld(candidate, frame), camera) : undefined;
  return <section className={`ai-player-map ${props.className || ''}`} aria-label="AI世界地图">
    <div ref={viewportRef} className={`ai-map-viewport ${placing ? 'is-placing' : ''}`} role="application" aria-label="可平移缩放的世界地图" aria-describedby={instruction} tabIndex={0}
        onContextMenu={event => event.preventDefault()}
        onPointerDown={event => {
          const point = localPoint(event.clientX, event.clientY); event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, point);
          if (pointers.current.size === 1) { gesture.current = { start: point, camera: { ...cameraRef.current }, moved: false, button: event.button }; suppressTap.current = false; }
          else if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()], centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), anchor: mapScreenToWorld(centre, cameraRef.current), camera: { ...cameraRef.current } }; suppressTap.current = true; }
        }}
        onPointerMove={event => {
          if (!pointers.current.has(event.pointerId)) return; const point = localPoint(event.clientX, event.clientY); pointers.current.set(event.pointerId, point);
          if (pointers.current.size >= 2 && pinch.current) { const [a, b] = [...pointers.current.values()], centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom = boundedMapZoom(pinch.current.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance); changeCamera({ x: centre.x - pinch.current.anchor.x * zoom, y: centre.y - pinch.current.anchor.y * zoom, zoom }); return; }
          const start = gesture.current; if (!start || suppressTap.current) return;
          const dx = point.x - start.start.x, dy = point.y - start.start.y; if (Math.hypot(dx, dy) > 6) start.moved = true;
          if (start.moved) changeCamera({ ...start.camera, x: start.camera.x + dx, y: start.camera.y + dy });
        }}
        onPointerUp={event => {
          const point = localPoint(event.clientX, event.clientY), start = gesture.current; pointers.current.delete(event.pointerId);
          if (!suppressTap.current && start && !start.moved && start.button === 0) {
            if (latest.current.placing && latest.current.chosenLandmark && !latest.current.pending) { const value = worldToNormalized(mapScreenToWorld(point, cameraRef.current), latest.current.frame); if (finiteMapPoint(value)) { setCandidate(value); setMessage('位置仅为预览；点击确认后才保存。'); } }
            else { const hit = hitMapCircle(latest.current.screenEntities, point); if (hit) latest.current.onEntityClick(hit.entity.id); else if (event.pointerType === 'touch') { if (lastTap.current && Date.now() - lastTap.current.time < 350 && Math.hypot(lastTap.current.point.x - point.x, lastTap.current.point.y - point.y) < 25) suggestDestination(point); lastTap.current = { time: Date.now(), point }; } }
          }
          if (!pointers.current.size) { gesture.current = undefined; pinch.current = undefined; suppressTap.current = false; }
        }}
        onPointerCancel={event => { pointers.current.delete(event.pointerId); if (!pointers.current.size) { gesture.current = undefined; pinch.current = undefined; suppressTap.current = false; } }}
        onDoubleClick={event => { event.preventDefault(); suggestDestination(localPoint(event.clientX, event.clientY)); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { setPlacing(false); setCandidate(undefined); return; }
          const direction = { ArrowUp: [0, 40], ArrowDown: [0, -40], ArrowLeft: [40, 0], ArrowRight: [-40, 0] }[event.key];
          if (direction) { event.preventDefault(); changeCamera({ ...cameraRef.current, x: cameraRef.current.x + direction[0], y: cameraRef.current.y + direction[1] }); }
          else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); changeCamera(zoomMapAt(cameraRef.current, { x: viewport.width / 2, y: viewport.height / 2 }, cameraRef.current.zoom * (event.key === '-' ? .8 : 1.25))); }
          else if (event.key === 'Home') { event.preventDefault(); returnToOwn(); }
        }}>
      <p className="ai-map-sr" id={instruction}>拖动平移，滚轮或双指缩放。头像大小保持不变。点按头像查看角色资料。{props.onMoveIntent ? '双击地图空白处将目标位置带入行动草稿。' : ''}</p>
      <svg className="ai-map-canvas" aria-hidden="true" width="100%" height="100%">
        <g data-ai-map-world="true" transform={`translate(${camera.x},${camera.y}) scale(${camera.zoom})`}>
          {image && image !== backgroundError && <image data-ai-map-background="true" href={image} width={frame.width} height={frame.height} preserveAspectRatio="none" onLoad={() => { if (backgroundError === image) setBackgroundError(''); }} onError={() => setBackgroundError(image)} />}
        </g>
        <g>{ghost && chosenLandmark && <g className="ai-map-placement-preview" transform={`translate(${ghost.x},${ghost.y})`} pointerEvents="none"><circle r="23" fill="#bfa36c33" stroke="#edcf91" strokeWidth="1.5" strokeDasharray="4 4" /><path d="M-8 0H8M0-8V8" stroke="#edcf91" strokeWidth="1.5" /><text y="39" textAnchor="middle" fill="#edcf91" fontSize="12">{chosenLandmark.name} · 预览</text></g>}</g>
      </svg>
      <div className="ai-map-screen-layer" data-ai-map-screen-layer="true">{screenEntities.map(value => <MapIdentity key={value.entity.id} value={value} own={value.entity.id === own?.id} onOpen={() => { if (!placing) props.onEntityClick(value.entity.id); }} />)}</div>
    </div>
    {props.canPlaceLandmarks && <details className="ai-map-host-panel"><summary>地标放置<span>{landmarks.length}</span></summary><div><label>选择地标<select value={selectedLandmark} disabled={pending} onChange={event => { setSelectedLandmark(event.target.value); setCandidate(undefined); setPlacing(false); }}><option value="">请选择AI定义的地标</option>{landmarks.map(entity => <option key={entity.id} value={entity.id}>{entity.name} · {landmarkNames[landmarkType(entity)] || '地标'} · {finiteMapPoint(entity.position) ? '已放置' : '未放置'}</option>)}</select></label>{!explicitFrame && <p>先设置地图尺寸，再放置地标。</p>}{chosenLandmark && finiteMapPoint(chosenLandmark.position) && <p>当前坐标 {chosenLandmark.position.x}, {chosenLandmark.position.y}</p>}<div className="ai-map-host-actions"><button type="button" disabled={!chosenLandmark || !explicitFrame || !props.onPlaceLandmark || pending} onClick={() => { setPlacing(!placing); setCandidate(undefined); setMessage(''); }}>{placing ? '取消选点' : '在地图上选点'}</button><button type="button" disabled={!chosenLandmark?.position || !props.onPlaceLandmark || pending} onClick={() => void savePlacement(null)}>移除坐标</button></div>{candidate && <><p>预览坐标 {candidate.x.toFixed(4)}, {candidate.y.toFixed(4)}</p><button className="ai-map-confirm-position" type="button" disabled={pending} onClick={() => void savePlacement(candidate)}>{saving ? '正在保存…' : '确认地标位置'}</button></>}{placing && !candidate && <p>点击地图选择位置；按 Esc 取消。</p>}</div></details>}
    {(message || props.error || backgroundError === image && image) && <p className="ai-map-status" role={props.error || backgroundError === image ? 'alert' : 'status'}>{props.error || (backgroundError === image && image ? '地图图片暂时无法加载。角色资料与位置仍保留。' : message)}</p>}
    <div className="ai-map-controls" role="group" aria-label="地图显示控制">
      <button type="button" onClick={returnToOwn} disabled={!own} title="以合适缩放居中查看自己的当前位置"><MapControlIcon kind="focus" /><span>回归当前位置</span></button>
      <button type="button" aria-pressed={hideOtherPlayers} onClick={() => setHideOtherPlayers(value => !value)} title="只改变这台设备上的显示"><MapControlIcon kind="players" /><span>隐藏其他玩家</span></button>
      <button type="button" aria-pressed={showLandmarks} onClick={() => setShowLandmarks(value => !value)} title="显示已公开且已放置的地标"><MapControlIcon kind="landmarks" /><span>显示地标</span></button>
    </div>
  </section>;
}
