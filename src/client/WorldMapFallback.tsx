import { useId, useRef, useState } from 'react';
import type { Scene } from '../shared/model';
import type { TokenView as Actor } from '../shared/world';
import { tokenCentre, tokenSideCells, tokenFootprint, lineOfSight, actorColor, actorInitial } from './world-map-geometry';



const CELL = 48;
const isImage = (source?: string) => Boolean(source && /^(https?:|data:image\/)/i.test(source));
interface TokenProps { actor: Actor; gridFeet: number; selected: boolean; active: boolean; targeted: boolean; onPortraitResult: (id: string, source: string, loaded: boolean) => void }
function FallbackToken({ actor, gridFeet, selected, active, targeted, onPortraitResult }: TokenProps) {
  const clipId = 'map-portrait-' + useId().replace(/:/g, '');
  const latestSource = useRef(actor.portrait); latestSource.current = actor.portrait;
  const [loaded, setLoaded] = useState<string>(), [failed, setFailed] = useState<string>();
  const side = tokenSideCells(actor, gridFeet), centre = tokenCentre(actor, actor.position, gridFeet);
  const radius = CELL * (side > 1 ? .43 * side : tokenFootprint(actor) < 1 ? .22 : .34);
  const source = actor.portrait, color = actorColor(actor.id), hp = actor.hp ? Math.max(0, Math.min(1, actor.hp.current / Math.max(1, actor.hp.max))) : 0;
  return <g transform={`translate(${(centre.x + .5) * CELL},${(centre.y + .5) * CELL})`} opacity={actor.hidden ? .45 : 1}>
    <defs><clipPath id={clipId}><circle r={Math.max(1, radius - 2)} /></clipPath></defs>
    {side > 1 && <rect x={-side * CELL / 2 + 2} y={-side * CELL / 2 + 2} width={side * CELL - 4} height={side * CELL - 4} fill="none" stroke={color} opacity=".6" />}
    <circle cx="2" cy="4" r={radius + 2} fill="#05090f" opacity=".6" />
    {active && <circle r={radius + 7} fill="none" stroke="#d5bb84" strokeWidth="1.5" />}
    {selected && <circle r={radius + 4} fill="none" stroke="#f6e3b8" strokeWidth="2.5" />}
    {targeted && <circle r={radius + 10} fill="none" stroke="#df8d8d" strokeWidth="2" />}
    <circle r={radius + 1} fill="none" stroke={actorColor(actor.ownerId || actor.id)} strokeWidth="3" />
    <circle r={radius} fill={actor.kind === 'monster' ? '#533d43' : '#2c4142'} stroke={color} strokeWidth="2" />
    {source && isImage(source) && failed !== source && <image key={source} href={source} x={-radius + 2} y={-radius + 2} width={(radius - 2) * 2} height={(radius - 2) * 2} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} onLoad={() => { if (latestSource.current === source) { setLoaded(source); setFailed(undefined); onPortraitResult(actor.id, source, true); } }} onError={() => { if (latestSource.current === source) { setFailed(source); setLoaded(undefined); onPortraitResult(actor.id, source, false); } }} />}
    {(!source || loaded !== source || failed === source) && <text textAnchor="middle" dy="5" fill={color} fontSize="16" fontWeight="600">{actorInitial(actor)}</text>}
    <text textAnchor="middle" y={radius + 17} fill="#d6dce3" fontSize="10">{actor.name.slice(0, 10)}</text>
    {actor.hp && <><rect x={-radius} y={radius + 21} width={radius * 2} height="3" rx="1" fill="#0d131a" /><rect x={-radius} y={radius + 21} width={hp * radius * 2} height="3" rx="1" fill={hp < .3 ? '#dd8d84' : '#92baa0'} /></>}
  </g>;
}
export function WorldMapFallback({ scene, actors, selectedId, activeId, targetIds, gm, editableIds, camera, onBackgroundResult, onPortraitResult }: { scene: Scene; actors: Actor[]; selectedId: string; activeId?: string; targetIds: string[]; gm: boolean; editableIds: string[]; camera: { x: number; y: number; zoom: number }; onBackgroundResult: (source: string, loaded: boolean) => void; onPortraitResult: TokenProps['onPortraitResult'] }) {
  const patternId = 'map-grid-' + useId().replace(/:/g, '');
  return <svg className="map-fallback" width="100%" height="100%" aria-hidden="true"><g transform={`translate(${camera.x},${camera.y}) scale(${camera.zoom})`}>
    <defs><pattern id={patternId} width={CELL} height={CELL} patternUnits="userSpaceOnUse"><rect width={CELL} height={CELL} fill="#1b222c" stroke="#303a47" strokeWidth="1" /></pattern></defs>
    <rect width={scene.width * CELL} height={scene.height * CELL} fill={`url(#${patternId})`} />
    {scene.background && isImage(scene.background) && <image key={scene.background} href={scene.background} width={scene.width * CELL} height={scene.height * CELL} preserveAspectRatio="none" opacity=".8" onLoad={() => onBackgroundResult(scene.background!, true)} onError={() => onBackgroundResult(scene.background!, false)} />}
    {scene.terrain.map(part => <rect key={part.id} x={part.x * CELL} y={part.y * CELL} width={part.width * CELL} height={part.height * CELL} fill="#a78652" opacity=".3" />)}
    {scene.walls.map(wall => <line key={wall.id} x1={wall.a.x * CELL} y1={wall.a.y * CELL} x2={wall.b.x * CELL} y2={wall.b.y * CELL} stroke={wall.door ? '#d5aa6d' : '#a5b1bb'} opacity={wall.open ? .35 : 1} strokeWidth="5" />)}
    {scene.fog && !gm && Array.from({ length: scene.width }, (_, x) => Array.from({ length: scene.height }, (_, y) => !actors.some(actor => editableIds.includes(actor.id) && !actor.dead && !actor.conditions.some(condition => ['blinded', 'unconscious'].includes(condition)) && lineOfSight(scene, actor.position, { x, y })) && <rect key={x + ':' + y} x={x * CELL} y={y * CELL} width={CELL + .5} height={CELL + .5} fill="#0b1019" opacity=".97" />))}
    {actors.filter(actor => gm || !actor.hidden).map(actor => <FallbackToken key={actor.id} actor={actor} gridFeet={scene.gridFeet} selected={actor.id === selectedId} active={actor.id === activeId} targeted={targetIds.includes(actor.id)} onPortraitResult={onPortraitResult} />)}
  </g></svg>;
}
