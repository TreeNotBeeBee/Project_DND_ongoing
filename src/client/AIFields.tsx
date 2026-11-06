import type { AiDisplayField, DisplayJson } from '../shared/ai-display';

const sourceNames = { module: '模组原文', ai: 'AI补充', unknown: '未提供' };
const fieldNames: Record<string, string> = { hp: '生命', current: '当前', max: '上限', temp: '临时生命', abilities: '属性', ability: '属性', str: '力量', strength: '力量', dex: '敏捷', dexterity: '敏捷', con: '体质', constitution: '体质', int: '智力', intelligence: '智力', wis: '感知', wisdom: '感知', cha: '魅力', charisma: '魅力', ac: '护甲等级', speed: '速度', proficiency: '熟练', level: '等级', class: '职业', species: '物种', background: '背景', personality: '性格', history: '经历', motivation: '动机', goals: '目标', relationships: '关系', equipment: '装备', inventory: '背包', resources: '资源', spells: '法术', features: '特性', skills: '技能', description: '描述', text: '正文', title: '标题', name: '名称', place: '地点', location: '地点', secret: '秘密', notes: '笔记', appearance: '外观', age: '年龄', languages: '语言', edition: '规则版本', fields: '资料字段', value: '内容', source: '来源', visibility: '可见范围', audience: '指定角色', id: '标识', kind: '类型', position: '位置', image: '图片', type: '类型', narratives: '叙事', entities: '实体', map: '地图', width: '宽度', height: '高度', pending: '待确认', freedom: '自由度', moduleid: '模组标识' };
export function aiFieldLabel(key: string) { return fieldNames[key.toLowerCase()] || key; }
export function AiJsonTree({ value, depth = 0 }: { value: DisplayJson; depth?: number }) {
  if (value === null) return <span className="ai-null">未提供 · null</span>;
  if (typeof value !== 'object') return <span className="ai-value">{String(value)}</span>;
  const entries = Object.entries(value);
  if (!entries.length) return <span className="ai-null">{Array.isArray(value) ? '[]' : '{}'}</span>;
  return <details className="ai-json-tree" open={depth < 2}><summary>{Array.isArray(value) ? `列表 · ${entries.length} 项` : `内容 · ${entries.length} 项`}</summary><dl>{entries.map(([key, child]) => <div key={key}><dt>{aiFieldLabel(key)}</dt><dd><AiJsonTree value={child} depth={depth + 1} /></dd></div>)}</dl></details>;
}
export function AiFields({ fields }: { fields: Record<string, AiDisplayField> }) {
  return Object.keys(fields).length ? <dl className="ai-fields">{Object.entries(fields).map(([id, field]) => <div key={id}><dt><strong>{aiFieldLabel(id)}</strong><span className={`ai-source ai-source-${field.source}`}>{sourceNames[field.source]}</span>{field.visibility === 'gm' && <span className="ai-source">仅房主</span>}</dt><dd>{field.pending ? <span className="ai-null">待房主确认</span> : <AiJsonTree value={field.value} />}</dd></div>)}</dl> : <p className="w-subtle">没有已公开的详细字段。</p>;
}
