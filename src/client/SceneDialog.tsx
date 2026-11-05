import { useEffect, useRef, useState } from 'react';
import type { Scene } from '../shared/model';
import { Field, Modal } from './components';

export function SceneDialog({ scene, onClose, onSave, saveError = '' }: {
  scene: Scene; onClose: () => void; saveError?: string;
  onSave: (value: Scene) => Promise<boolean | undefined>;
}) {
  const [draft, setDraft] = useState({ ...scene });
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [previewVersion, setPreviewVersion] = useState(0);
  const [imageStatus, setImageStatus] = useState<'empty' | 'loading' | 'ready' | 'error'>(scene.background ? 'loading' : 'empty');
  const upload = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  const source = draft.background || '';
  const currentSource = useRef(source); currentSource.current = source;
  useEffect(() => () => { upload.current++; }, []);
  const setBackground = (value: string) => {
    upload.current++; setReading(false); setError(''); setFileName('');
    setPreviewVersion(value => value + 1);
    setImageStatus(value ? 'loading' : 'empty');
    setDraft(previous => ({ ...previous, background: value || undefined }));
  };
  const supported = !source || /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source) || /^https:\/\//i.test(source);
  const previewError = !supported ? '请使用 HTTPS 图片地址，或上传 PNG、JPEG、WebP、GIF 图片。' : imageStatus === 'error' ? '图片无法加载。请检查地址、图片格式及图片站点是否允许跨域使用，或改为上传本地文件。' : '';
  return <Modal title="布置冒险场景" eyebrow="SCENE SETTINGS" error={error || previewError || saveError} onClose={onClose}>
    <form onSubmit={async event => {
      event.preventDefault(); if (reading || error || previewError || source && imageStatus !== 'ready') return;
      setBusy(true); setError('');
      try { if (await onSave(draft)) onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '场景保存失败，请重试。'); }
      finally { setBusy(false); }
    }}>
      <div className="dialog-body">
        <div className="form-grid">
          <Field label="宽度（格）"><input type="number" min="5" max="100" required value={draft.width} onChange={event => setDraft({ ...draft, width: Number(event.target.value) })} /></Field>
          <Field label="高度（格）"><input type="number" min="5" max="100" required value={draft.height} onChange={event => setDraft({ ...draft, height: Number(event.target.value) })} /></Field>
          <Field label="每格距离（尺）"><input type="number" min="1" max="30" required value={draft.gridFeet} readOnly /></Field>
          <Field label="战争迷雾"><select value={draft.fog ? 'on' : 'off'} onChange={event => setDraft({ ...draft, fog: event.target.value === 'on' })}><option value="off">关闭</option><option value="on">开启（服务器按视野过滤）</option></select></Field>
        </div>
        <Field label="背景地图地址" hint={source.startsWith('data:') ? '已选择本地图片，下面显示预览。点击保存场景后才会更新地图。' : '使用允许跨域读取的 HTTPS 图片，或直接上传本地文件。'}><input value={source} placeholder="https://…" onChange={event => setBackground(event.target.value.trim())} /></Field>
        <Field label="本地背景图片" hint="支持 PNG、JPEG、WebP、GIF，最大 4MB。"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          const attempt = ++upload.current; setError('');
          if (file.size > 4 * 1024 * 1024) { setReading(false); setError('背景图片请控制在 4MB 以内。'); return; }
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setReading(false); setError('请选择 PNG、JPEG、WebP 或 GIF 图片。'); return; }
          setReading(true);
          const reader = new FileReader();
          reader.onload = () => { if (upload.current !== attempt) return; setReading(false); setFileName(file.name); setImageStatus('loading'); setPreviewVersion(value => value + 1); setDraft(previous => ({ ...previous, background: String(reader.result) })); };
          reader.onerror = () => { if (upload.current === attempt) { setReading(false); setError('文件读取失败，请重新选择图片。'); } };
          reader.readAsDataURL(file);
        }} /></Field>
        {source && supported && <figure className="scene-image-preview"><img key={previewVersion} src={source} crossOrigin="anonymous" alt="背景地图预览" onLoad={() => { if (currentSource.current === source) setImageStatus('ready'); }} onError={() => { if (currentSource.current === source) setImageStatus('error'); }} /><figcaption>{fileName ? `${fileName} · ` : ''}{imageStatus === 'ready' ? '预览已就绪；保存后显示在冒险桌。' : imageStatus === 'error' ? '预览加载失败。' : '正在读取图片…'}</figcaption></figure>}
        <div className="scene-image-actions"><p role="status">{reading ? '正在读取本地文件…' : source ? '背景将铺满所设定的网格范围。' : '未设置背景，使用默认网格。'}</p>{(source || error) && <button type="button" className="button ghost small" onClick={() => { setBackground(''); if (fileInput.current) fileInput.current.value = ''; }}>清除背景</button>}</div>
        <p className="notice">缩小场景前，请把棋子移到新边界内。墙、门和地形使用地图工具编辑。</p>
      </div>
      <footer className="dialog-footer"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy || reading || Boolean(error || previewError) || Boolean(source && imageStatus !== 'ready')}>{busy ? '保存中…' : '保存场景'}</button></footer>
    </form>
  </Modal>;
}
