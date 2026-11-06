import type { Actor, Command, Position, Scene } from '../shared/model';

export const ABILITY_LABELS = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
export const SKILLS: Record<string, string> = { acrobatics: '杂技', 'animal-handling': '驯兽', arcana: '奥秘', athletics: '运动', deception: '欺瞒', history: '历史', insight: '洞悉', intimidation: '威吓', investigation: '调查', medicine: '医药', nature: '自然', perception: '察觉', performance: '表演', persuasion: '说服', religion: '宗教', 'sleight-of-hand': '巧手', stealth: '隐匿', survival: '求生' };
export const CONDITIONS: Record<string, string> = { blinded: '目盲', charmed: '魅惑', deafened: '耳聋', exhaustion: '力竭', frightened: '恐慌', grappled: '受擒', incapacitated: '失能', invisible: '隐形', paralyzed: '麻痹', petrified: '石化', poisoned: '中毒', prone: '倒地', restrained: '束缚', stunned: '震慑', unconscious: '昏迷' };
export const DAMAGE_LABELS: Record<string, string> = { acid: '强酸', bludgeoning: '钝击', cold: '冷冻', fire: '火焰', force: '力场', lightning: '闪电', necrotic: '黯蚀', piercing: '穿刺', poison: '毒素', psychic: '心灵', radiant: '光耀', slashing: '挥砍', thunder: '雷鸣' };
export const AUTOMATION = { automatic: ['自动结算', 'auto'], choice: ['需要选择', 'choice'], adjudication: ['主持人裁定', 'judge'], unsupported: ['尚未自动化', 'unsupported'] } as const;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export function validateArchiveBody(body: unknown) {
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_ARCHIVE_BYTES) throw new Error('序列化后的存档超过 64MiB 导入上限。原文件未修改；请按主角及其随从分包，并保留原始总备份。');
}
export const CATEGORY_LABELS: Record<string, string> = { class: '职业', classes: '职业', subclass: '子职', subclasses: '子职', species: '物种', race: '物种', races: '物种', background: '背景', backgrounds: '背景', feat: '专长', feats: '专长', feature: '能力', features: '能力', spell: '法术', spells: '法术', equipment: '装备', item: '物品', 'magic-item': '魔法物品', monster: '怪物', monsters: '怪物', condition: '状态', rule: '规则' };
export const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}`;
export function resourceLabel(id: string, name: string) {
  if (id.startsWith('slot-')) return `${id.slice(5)} 环法术位`;
  if (id.startsWith('pact-')) return `${id.slice(5)} 环契约魔法`;
  if (id.startsWith('hit-dice-')) return `生命骰 · ${name.match(/\(d\d+\)/)?.[0] || id.slice(9)}`;
  return ({ gp: '金币 · GP', 'second-wind': '回气', 'action-surge': '动作如潮', rage: '狂暴', 'lay-on-hands': '圣疗', 'magic-initiate': '魔法学徒 · 免费施放', focus: '气点', sorcery: '术法点', 'bardic-inspiration': '诗人激励', 'wild-shape': '荒野形态', indomitable: '不屈' } as Record<string, string>)[id] || name;
}
export const uid = () => crypto.randomUUID();
export const actorInitial = (actor: Pick<Actor, 'name'>) => Array.from(actor.name.trim())[0] || '?';
export const actorColor = (id: string) => ['#8fc9ac', '#c6a8e6', '#e3bb7b', '#8abce2', '#e3a5a5', '#a9c779'][Array.from(id).reduce((v, c) => v + c.charCodeAt(0), 0) % 6];
export const isEditable = (actor: Actor, member: { id: string; role: string }) => member.role === 'gm' || actor.ownerId === member.id;
export const queueKey = (campaignId: string, memberId: string) => `jigerpg_v1_pending:${campaignId}:${memberId}`;
export function safeFilename(name: string) { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'JigeRPG'; }
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = safeFilename(filename); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function readLegacyStorage(storage: Pick<Storage, 'length' | 'key' | 'getItem'>) {
  const raw: Record<string, string> = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && (key === 'jigerpg_charlist_v04' || key.startsWith('jigerpg_char_') || key === 'jigerpg_gm_v1')) {
      const value = storage.getItem(key); if (value !== null) raw[key] = value;
    }
  }
  return { format: 'jigerpg-legacy-storage', version: 1, exportedAt: new Date().toISOString(), raw };
}
export function parseLegacyFile(text: string) {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请选择 JigeRPG 导出的 JSON 存档。');
  return value;
}
export function prepareCommand(type: string, expectedRev: number, actorId?: string, payload: Record<string, unknown> = {}, targetIds: string[] = []): Command {
  return { operationId: uid(), expectedRev, type, actorId, payload, targetIds };
}
