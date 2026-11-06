import type { AiMapView } from '../shared/ai-display';

export interface AiMapPoint { x: number; y: number }
export interface AiMapCamera extends AiMapPoint { zoom: number }
export interface AiMapViewport { width: number; height: number }
export const AI_AVATAR_RADIUS = 25;
export const AI_LANDMARK_RADIUS = 18;
export const DEFAULT_AI_MAP_FRAME = { width: 1000, height: 1000 };

/** A display glyph, never a rewritten character name. Skip emoji, numbers and punctuation. */
export function aiNameInitial(name: string): string {
  for (const character of name.normalize('NFC')) if (/\p{Script=Han}|\p{L}/u.test(character)) return character;
  return '?';
}
export function finiteMapPoint(value: unknown): value is AiMapPoint {
  return Boolean(value && typeof value === 'object' && Number.isFinite((value as AiMapPoint).x) && Number.isFinite((value as AiMapPoint).y));
}
export function mapFrame(map?: Pick<AiMapView, 'width' | 'height'>): AiMapViewport | undefined {
  return map && Number.isFinite(map.width) && Number.isFinite(map.height) && map.width > 0 && map.height > 0 ? { width: map.width, height: map.height } : undefined;
}
export function normalizedToWorld(position: AiMapPoint, frame: AiMapViewport): AiMapPoint { return { x: position.x * frame.width, y: position.y * frame.height }; }
/** Preserve out-of-frame coordinates; only the user/AI command may change data. */
export function worldToNormalized(position: AiMapPoint, frame: AiMapViewport): AiMapPoint { return { x: position.x / frame.width, y: position.y / frame.height }; }
export function mapWorldToScreen(position: AiMapPoint, camera: AiMapCamera): AiMapPoint { return { x: camera.x + position.x * camera.zoom, y: camera.y + position.y * camera.zoom }; }
export function mapScreenToWorld(position: AiMapPoint, camera: AiMapCamera): AiMapPoint { return { x: (position.x - camera.x) / camera.zoom, y: (position.y - camera.y) / camera.zoom }; }
export function boundedMapZoom(zoom: number): number { return Math.max(.000001, Math.min(64, Number.isFinite(zoom) ? zoom : 1)); }
export function zoomMapAt(camera: AiMapCamera, screen: AiMapPoint, zoom: number): AiMapCamera {
  const anchor = mapScreenToWorld(screen, camera), next = boundedMapZoom(zoom);
  return { x: screen.x - anchor.x * next, y: screen.y - anchor.y * next, zoom: next };
}
export function focusAiMap(frame: AiMapViewport, viewport: AiMapViewport, position: AiMapPoint): AiMapCamera {
  const zoom = boundedMapZoom(Math.min(Math.max(1, viewport.width - 80) / frame.width, Math.max(1, viewport.height - 120) / frame.height, 1));
  return { x: viewport.width / 2 - position.x * zoom, y: viewport.height / 2 - position.y * zoom, zoom };
}
export function hitMapCircle<T extends { screen: AiMapPoint; radius: number }>(items: T[], point: AiMapPoint): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (Math.hypot(items[index].screen.x - point.x, items[index].screen.y - point.y) <= items[index].radius) return items[index];
  return undefined;
}
export function mapImageSource(source?: string): string | undefined {
  return source && (/^https:\/\//i.test(source) || /^\/api\/assets\/[a-zA-Z0-9-]+$/.test(source) || /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(source)) ? source : undefined;
}
