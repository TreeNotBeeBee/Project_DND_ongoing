import { useEffect, useState } from 'react';
import { api } from './transport';
import { WorldCopy, WorldField } from './WorldPrimitives';

interface Invitation { inviteCode: string; url: string; qrDataUrl: string; tunnelStatus: string; isPublic: boolean }
export function AIInvitation() {
  const [invitation, setInvitation] = useState<Invitation>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); setError(''); try { setInvitation(await api<Invitation>('/api/invitation')); } catch (reason) { setError(reason instanceof Error ? reason.message : '读取邀请失败'); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, []);
  return <main className="ai-invite w-surface"><p className="w-eyebrow">INVITE YOUR PARTY</p><h1>邀请伙伴加入</h1><p>伙伴登录自己的账号后，输入邀请码或打开邀请链接。</p>{error && <p role="alert" className="w-alert">{error}</p>}{invitation && <><p className="w-notice">{invitation.isPublic ? '公网邀请可用' : '当前为本机访问地址'} · {invitation.tunnelStatus}</p><WorldField label="邀请码"><input readOnly value={invitation.inviteCode} /></WorldField><WorldField label="邀请链接"><input readOnly value={invitation.url} /></WorldField>{invitation.qrDataUrl && <img className="ai-invite-qr" src={invitation.qrDataUrl} alt="加入此世界的邀请二维码" />}<div className="w-actions"><WorldCopy value={invitation.inviteCode} label="复制邀请码" /><WorldCopy value={invitation.url} label="复制邀请链接" /></div></>}<button className="w-button secondary small" disabled={busy} onClick={() => void load()}>{busy ? '读取邀请地址…' : '刷新邀请地址'}</button><p className="w-subtle">房主电脑与启动器须保持运行。公网地址变化后，请刷新并分享新的邀请链接。</p></main>;
}
