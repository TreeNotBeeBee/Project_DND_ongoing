import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Command } from '../shared/model';

export const WorldFeedback = createContext<((acknowledged?: (command: Command) => void) => ReactNode) | undefined>(undefined);
export function WorldModal({ title, subtitle, children, onClose, error, wide, onAcknowledged }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; error?: string; wide?: boolean; onAcknowledged?: (command: Command) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), feedback = useContext(WorldFeedback);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { if (element.open) element.close(); }; }, []);
  return <dialog ref={dialog} className={`world-modal${wide ? ' world-modal-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}><header><div>{subtitle && <p className="w-eyebrow">{subtitle}</p>}<h2 id={titleId}>{title}</h2></div><button type="button" className="w-icon" aria-label="关闭弹窗" onClick={onClose}>×</button></header><div className="w-modal-feedback">{error && <p className="w-alert" role="alert">{error}</p>}{feedback?.(onAcknowledged)}</div>{children}</dialog>;
}
export function WorldField({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const id = useId();
  const controls = Children.map(children, child => isValidElement<Record<string, any>>(child) && typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type) ? cloneElement(child, { id: child.props.id || id, 'aria-labelledby': `${id}-label`, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) }) : child);
  return <label className={`w-field ${className}`} htmlFor={id}><span id={`${id}-label`}>{label}</span>{controls}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function WorldEmpty({ title, children, symbol = '✧' }: { title: string; children?: ReactNode; symbol?: string }) {
  return <div className="w-empty"><span aria-hidden="true">{symbol}</span><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
export function WorldAvatar({ name, portrait, size = 'normal', onClick }: { name: string; portrait?: string; size?: 'small' | 'normal' | 'large'; onClick?: () => void }) {
  const [failed, setFailed] = useState('');
  const content = <>{portrait && /^(https:\/\/|\/api\/assets\/|data:image\/(png|jpe?g|webp|gif);base64,)/i.test(portrait) && failed !== portrait ? <img src={portrait} alt="" onError={() => setFailed(portrait)} /> : <span>{Array.from(name.trim())[0] || '✧'}</span>}</>;
  return onClick ? <button type="button" className={`w-avatar w-avatar-${size}`} aria-label={`查看${name}的公开资料`} onClick={onClick}>{content}</button> : <span className={`w-avatar w-avatar-${size}`}>{content}</span>;
}
export function WorldForm({ children, onSubmit, submitLabel = '保存', cancel, busyLabel = '正在保存…', error = '', footer }: { children: ReactNode; onSubmit: () => Promise<boolean | void>; submitLabel?: string; busyLabel?: string; cancel?: () => void; error?: string; footer?: ReactNode }) {
  const [busy, setBusy] = useState(false), [localError, setLocalError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy) return; setBusy(true); setLocalError(''); try { await onSubmit(); } catch (reason) { setLocalError(reason instanceof Error ? reason.message : '保存失败，请重试。'); } finally { setBusy(false); } };
  return <form onSubmit={event => void submit(event)}>{(localError || error) && <div className="w-sticky-error" role="alert">{localError || error}</div>}<fieldset className="w-form-fields" disabled={busy}>{children}</fieldset><footer className="w-form-footer">{footer}<div className="w-actions">{cancel && <button type="button" className="w-button secondary" onClick={cancel}>取消</button>}<button className="w-button primary" disabled={busy}>{busy ? busyLabel : submitLabel}</button></div></footer></form>;
}
export function WorldConfirm({ title, children, onClose, onConfirm, error, label = '确认', commandTypes }: { title: string; children: ReactNode; onClose: () => void; onConfirm: () => Promise<boolean>; error?: string; label?: string; commandTypes?: string[] }) {
  return <WorldModal title={title} onClose={onClose} error={error} onAcknowledged={command => { if (commandTypes?.includes(command.type)) onClose(); }}><WorldForm onSubmit={async () => { if (await onConfirm()) onClose(); }} cancel={onClose} submitLabel={label}><div className="w-modal-body w-prose">{children}</div></WorldForm></WorldModal>;
}
export function WorldCopy({ value, label = '复制' }: { value: string; label?: string }) {
  const [state, setState] = useState('');
  return <button type="button" className="w-button secondary small" onClick={async () => { try { await navigator.clipboard.writeText(value); setState('已复制'); } catch { setState('请手动选择复制'); } }}>{state || label}</button>;
}
export function JsonInput({ value, onChange, label, hint, rows = 12 }: { value: string; onChange: (value: string) => void; label: string; hint?: string; rows?: number }) {
  return <WorldField label={label} hint={hint}><textarea className="w-code" rows={rows} value={value} onChange={event => onChange(event.target.value)} spellCheck={false} autoCapitalize="off" /></WorldField>;
}
export async function readWorldJson(file: File): Promise<unknown> {
  if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MiB。请保留原件并拆分后再导入。');
  try { return JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON。原文件未修改。'); }
}
export function saveWorldJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const worldAbilityNames: Record<string, string> = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
export const worldSigned = (value: number) => value >= 0 ? `+${value}` : String(value);
