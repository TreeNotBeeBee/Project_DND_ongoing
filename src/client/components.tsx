import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ContentEntry } from '../shared/model';
import { AUTOMATION, CATEGORY_LABELS } from './client-utils';
import { zhName } from './labels';
import './modal-feedback.css';

export const ModalFeedbackContext = createContext<ReactNode>(null);

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Z" /><path d="M9 3v16M15 5v16" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 15a5 5 0 0 1 4 5" /></>,
    book: <><path d="M12 5c-3-3-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-2-9 1ZM12 5v15" /><path d="M6 8h3M6 11h3M15 8h3M15 11h3" /></>,
    import: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 4 2 2 1 4 3 1 3 3 3-3 3-1 1-4 2-2-2-4-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
    dice: <><path d="m12 2 10 6-3 12H5L2 8Z" /><path d="m12 2-5 9 5 9 5-9ZM2 8l5 3M22 8l-5 3M5 20l2-9M19 20l-2-9" /></>,
    sword: <><path d="m5 3 16 16-2 2L3 5V3ZM14 14l5-5M12 16l-3 3M3 21l5-5M16 12l3-3" /></>,
    plus: <path d="M12 4v16M4 12h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    shield: <><path d="m12 2 9 4v6c0 5-6 9-9 10-3-1-9-5-9-10V6Z" /><path d="m8 12 3 3 5-6" /></>,
    link: <><path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(0 0) scale(.9)" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.dice}</svg>;
}
export function Modal({ title, eyebrow, children, onClose, wide = false, error = '' }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  const feedback = useContext(ModalFeedbackContext);
  useEffect(() => { const element = ref.current!; element.showModal(); return () => { if (element.open) element.close(); }; }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientY < box.top || event.clientX > box.right || event.clientY > box.bottom) onClose(); } }}><header className="dialog-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2>{error && <p className="modal-error" role="alert">{error}</p>}{feedback && <div className="modal-command-feedback">{feedback}</div>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button></header>{children}</dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const controls = Children.map(children, child => {
    if (!isValidElement<Record<string, any>>(child) || typeof child.type !== 'string' || !['input', 'select', 'textarea'].includes(child.type)) return child;
    return cloneElement(child, { id: child.props.id || id, ...(!child.props['aria-label'] ? { 'aria-labelledby': `${id}-label` } : {}), ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) });
  });
  return <label className="field" htmlFor={id}><span id={`${id}-label`}>{label}</span>{controls}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function Empty({ symbol = '✧', title, children }: { symbol?: string; title: string; children?: ReactNode }) { return <div className="empty-state"><span>{symbol}</span><h3>{title}</h3>{children && <p>{children}</p>}</div>; }
export function AutomationBadge({ status }: { status: ContentEntry['automation'] }) { const [label, style] = AUTOMATION[status] || AUTOMATION.unsupported; return <span className={`automation ${style}`}><i />{label}</span>; }
export function entryLabel(entry?: ContentEntry, fallback = '') { return entry ? entry.nameZh || zhName(entry.id, entry.name) : fallback; }
export function contentById(entries: ContentEntry[], id: string, category?: string) { return entries.find(entry => entry.id === id || (!category || entry.category === category) && entry.id.split(':').pop() === id.split(':').pop()); }
export function categoryIs(entry: ContentEntry, ...names: string[]) { return names.some(name => entry.category === name || entry.category === `${name}s` || entry.id.startsWith(`${name}:`)); }
export function ContentPicker({ entries, value, onChange, label, multiple = false, disabled = false }: { entries: ContentEntry[]; value: string | string[]; onChange: (value: string | string[]) => void; label: string; multiple?: boolean; disabled?: boolean }) {
  const [query, setQuery] = useState('');
  if (!multiple) return <Field label={label}><select value={value as string} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">请选择{label}</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{entryLabel(entry)}{entry.automation !== 'automatic' ? ' · ' + AUTOMATION[entry.automation][0] : ''}</option>)}</select></Field>;
  const selected = value as string[]; const filtered = entries.filter(entry => `${entry.name} ${entryLabel(entry)}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="field content-picker"><span>{label}<small>已选 {selected.length}</small></span><div className="search-box"><Icon name="search" size={16} /><input aria-label={`搜索${label}`} placeholder={`搜索${label}…`} value={query} onChange={event => setQuery(event.target.value)} /></div><div className="picker-options">{filtered.slice(0, 100).map(entry => <label key={entry.id} className={`picker-option ${selected.includes(entry.id) ? 'selected' : ''}`}><input type="checkbox" disabled={disabled} checked={selected.includes(entry.id)} onChange={event => onChange(event.target.checked ? [...selected, entry.id] : selected.filter(id => id !== entry.id))} /><span>{entryLabel(entry)}<small>{entry.category === 'spell' || entry.category === 'spells' ? `${entry.data.level || 0} 环 · ` : ''}{CATEGORY_LABELS[entry.category] || entry.category}</small></span><AutomationBadge status={entry.automation} /></label>)}{!filtered.length && <p className="muted">没有匹配的条目。</p>}{filtered.length > 100 && <p className="muted">输入名称查找更多条目。</p>}</div></div>;
}
export function Confirm({ title, children, confirmText = '确认', onConfirm, onClose, danger = false }: { title: string; children: ReactNode; confirmText?: string; onConfirm: () => void | Promise<void>; onClose: () => void; danger?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title={title} onClose={onClose}><div className="dialog-body">{children}{error && <p className="error-text" role="alert">{error}</p>}</div><footer className="dialog-footer"><button className="button ghost" onClick={onClose}>取消</button><button className={`button ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }}>{busy ? '处理中…' : confirmText}</button></footer></Modal>;
}
