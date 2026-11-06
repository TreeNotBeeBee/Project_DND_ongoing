import type { AiDisplayView } from '../shared/ai-display';
import { AiFields } from './AIFields';

/** Only receives the already projected player view; raw module documents never enter this component. */
export function AIStoryInfo({ display }: { display: AiDisplayView }) {
  const initialization = display.initialization;
  if (!initialization) return null;
  return <section className="ai-opening-info" aria-label="开幕与世界资料">
    <h3>开幕剧情</h3><AiFields fields={initialization.opening.fields} />
    <details><summary>世界背景与模组规则</summary>
      <h3>世界观</h3><AiFields fields={initialization.setting.fields} />
      <h3>背景设定</h3><AiFields fields={initialization.background.fields} />
      <h3>模组规则 · {initialization.rules.edition === '5e2014' ? 'DND 5e 2014' : 'DND 2024'}</h3><AiFields fields={initialization.rules.fields} />
    </details>
  </section>;
}
