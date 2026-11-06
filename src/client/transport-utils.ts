import type { Command } from '../shared/model';
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export function validateArchiveBody(body: unknown) {
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_ARCHIVE_BYTES) throw new Error('序列化后的存档超过 64MiB 导入上限。原文件未修改，请保留原始总备份。');
}
export const queueKey = (campaignId: string, memberId: string) => `jigerpg_v1_pending:${campaignId}:${memberId}`;
export function prepareCommand(type: string, expectedRev: number, actorId?: string, payload: Record<string, unknown> = {}, targetIds: string[] = []): Command {
  return { operationId: crypto.randomUUID(), expectedRev, type, actorId, payload, targetIds };
}
