import type { WorldDraft } from '../shared/world';
export interface CachedWorldDraft { key: string; campaignId: string; memberId: string; draftId?: string; kind: WorldDraft['kind']; title: string; text: string; updatedAt: number }
function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open('jigerpg-world-private-drafts', 1); request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'key' }); }; request.onerror = () => reject(request.error || new Error('无法打开本机草稿库')); request.onsuccess = () => resolve(request.result); });
}
export const draftCacheKey = (campaignId: string, memberId: string, draftId?: string) => JSON.stringify([campaignId, memberId, draftId || 'new']);
export async function writeDraftCache(value: CachedWorldDraft): Promise<void> {
  const database = await openCache(); return new Promise((resolve, reject) => { const transaction = database.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').put(value); transaction.oncomplete = () => { database.close(); resolve(); }; transaction.onerror = () => { database.close(); reject(transaction.error || new Error('本机草稿写入失败')); }; });
}
export async function readDraftCache(campaignId: string, memberId: string, draftId?: string): Promise<CachedWorldDraft | undefined> {
  const database = await openCache(); return new Promise((resolve, reject) => { const transaction = database.transaction('drafts', 'readonly'), request = transaction.objectStore('drafts').get(draftCacheKey(campaignId, memberId, draftId)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); transaction.oncomplete = () => database.close(); });
}
export async function deleteDraftCache(campaignId: string, memberId: string, draftId?: string): Promise<void> {
  const database = await openCache(); return new Promise((resolve, reject) => { const transaction = database.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').delete(draftCacheKey(campaignId, memberId, draftId)); transaction.oncomplete = () => { database.close(); resolve(); }; transaction.onerror = () => { database.close(); reject(transaction.error); }; });
}
