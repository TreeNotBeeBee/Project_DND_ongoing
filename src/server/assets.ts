import { createHash, randomUUID } from 'node:crypto';
import type { GameDatabase } from './database';
import type { GameState, Session } from '../shared/model';
import { ApiError } from './security';
const pattern = /\/api\/assets\/([a-zA-Z0-9-]{8,128})/g;
export function assetReferences(value: unknown): string[] { return [...new Set([...JSON.stringify(value).matchAll(pattern)].map(match => match[1]))]; }
export interface AssetContext { db: GameDatabase; raw: (campaignId: string) => GameState; projected: (session: Session) => unknown }
export function canReadAsset(context: AssetContext, session: Session, id: string): boolean {
  const asset = context.db.prepare('SELECT campaign_id,owner_id FROM assets WHERE id=?').get(id) as { campaign_id: string; owner_id: string } | undefined;
  if (!asset || asset.campaign_id !== session.campaignId) return false;
  if (asset.owner_id === session.member.id || context.raw(session.campaignId).world?.ownerId === session.member.id) return true;
  return assetReferences(context.projected(session)).includes(id);
}
/** Check against the OLD view: a forged new reference cannot make a secret asset public. */
export function validateAssetReferences(context: AssetContext, session: Session, value: unknown) {
  for (const id of assetReferences(value)) if (!canReadAsset(context, session, id)) throw new ApiError(403, 'asset_permission', '图片不存在或你无权引用，请自行上传图片');
}
export function saveImageAsset(context: AssetContext, session: Session, dataUrl: unknown) {
  if (typeof dataUrl !== 'string') throw new ApiError(400, 'image_required', '请上传图片');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) throw new ApiError(400, 'invalid_image', '支持PNG、JPEG、WebP、GIF图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new ApiError(413, 'image_size', '图片须在4MiB以内');
  const good = match[1] === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : match[1] === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
  if (!good) throw new ApiError(400, 'invalid_image', '图片内容与格式不符');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const existing = context.db.prepare('SELECT id FROM assets WHERE campaign_id=? AND owner_id=? AND sha256=?').get(session.campaignId, session.member.id, sha) as { id: string } | undefined;
  const id = existing?.id || randomUUID();
  if (!existing) context.db.prepare('INSERT INTO assets(id,campaign_id,owner_id,mime,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(id, session.campaignId, session.member.id, match[1], sha, bytes, new Date().toISOString());
  return { id, url: `/api/assets/${id}`, mime: match[1], bytes: bytes.length };
}
export function exportAssets(db: GameDatabase, campaignId: string, references?: string[]) {
  const rows = db.prepare('SELECT id,owner_id,mime,sha256,bytes,created_at FROM assets WHERE campaign_id=?').all(campaignId) as any[];
  return rows.filter(row => !references || references.includes(row.id)).map(row => ({ id: row.id, ownerId: row.owner_id, mime: row.mime, sha256: row.sha256, data: Buffer.from(row.bytes).toString('base64'), createdAt: row.created_at }));
}
export function restoreAssets(db: GameDatabase, campaignId: string, records: unknown, members: Set<string>) {
  if (records === undefined) return;
  if (!Array.isArray(records) || records.length > 10000) throw new ApiError(400, 'backup_assets', '备份图片列表无效');
  for (const row of records) {
    if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(row.id) || !members.has(row.ownerId) || typeof row.data !== 'string') throw new ApiError(400, 'backup_assets', '备份图片归属无效');
    const bytes = Buffer.from(row.data, 'base64');
    if (bytes.length > 4 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== row.sha256 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(row.mime)) throw new ApiError(400, 'backup_assets', '备份图片校验失败');
    const existing = db.prepare('SELECT campaign_id FROM assets WHERE id=?').get(row.id) as any;
    if (existing && existing.campaign_id !== campaignId) throw new ApiError(400, 'backup_assets', '图片编号属于其他房间');
    db.prepare('INSERT INTO assets(id,campaign_id,owner_id,mime,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,mime=excluded.mime,sha256=excluded.sha256,bytes=excluded.bytes').run(row.id, campaignId, row.ownerId, row.mime, row.sha256, bytes, String(row.createdAt || new Date().toISOString()));
  }
}
