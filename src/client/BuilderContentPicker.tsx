import { useState } from 'react';
import type { ContentEntry } from '../shared/model';
import { CATEGORY_LABELS } from './client-utils';
import { entryLabel, Field, Icon } from './components';

const CAPABILITIES: Record<ContentEntry['automation'], string> = {
  automatic: '自动结算', choice: '有交互选项', adjudication: '主持人裁定', unsupported: '尚未自动化',
};
export function BuilderCapabilityBadge({ status }: { status: ContentEntry['automation'] }) {
  return <span className="builder-capability" data-capability={status} title="这是能力执行方式，不是建卡缺项" aria-label={`能力标记：${CAPABILITIES[status]}`}>{CAPABILITIES[status]}</span>;
}

/** Builder-only labels keep automation coverage distinct from required inputs. */
export function BuilderContentPicker({ entries, value, onChange, label, multiple = false, disabled = false, field, hint }: {
  entries: ContentEntry[]; value: string | string[]; onChange: (value: string | string[]) => void; label: string;
  multiple?: boolean; disabled?: boolean; field?: string; hint?: string;
}) {
  const [query, setQuery] = useState('');
  if (!multiple) return <Field label={label} hint={hint}><select data-builder-field={field} value={value as string} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">请选择{label}</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{entryLabel(entry)}{entry.automation !== 'automatic' ? ` · 能力：${CAPABILITIES[entry.automation]}` : ''}</option>)}</select></Field>;
  const selected = value as string[];
  const filtered = entries.filter(entry => `${entry.name} ${entryLabel(entry)}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="field content-picker" data-builder-field={field}><span>{label}<small>已选 {selected.length}</small></span>{hint && <small>{hint}</small>}<div className="search-box"><Icon name="search" size={16} /><input aria-label={`搜索${label}`} placeholder={`搜索${label}…`} value={query} onChange={event => setQuery(event.target.value)} /></div><div className="picker-options">{filtered.slice(0, 100).map(entry => <label key={entry.id} className={`picker-option ${selected.includes(entry.id) ? 'selected' : ''}`}><input type="checkbox" disabled={disabled} checked={selected.includes(entry.id)} onChange={event => onChange(event.target.checked ? [...selected, entry.id] : selected.filter(id => id !== entry.id))} /><span>{entryLabel(entry)}<small>{entry.category === 'spell' ? `${entry.data.level || 0} 环 · ` : ''}{CATEGORY_LABELS[entry.category] || entry.category}</small></span><BuilderCapabilityBadge status={entry.automation} /></label>)}{!filtered.length && <p className="muted">没有匹配的条目。</p>}{filtered.length > 100 && <p className="muted">输入名称查找更多条目。</p>}</div></div>;
}
