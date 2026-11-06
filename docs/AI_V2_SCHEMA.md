# AI 权威展示协议 v2 字段与可执行示例

此协议独立保存于 `world.ai.display`。运行时不构造 `Actor`，不调用战斗引擎、派生数值或自动合理性校验。生命为 0、负值、大于上限，上限为负值，均保留 AI 提供的有限 JSON 数字。字段展示不是本地裁定。

操作流程参见 [AI 展示模式指南](AI_DISPLAY_V2.md)。本文件记录机器接口，和旧 [v1 规则结算协议](AI_PROTOCOL.md) 分开。带 `display.version:2` 的世界只能使用 v2 展示入口；未带 display 的旧 AI 世界保持旧兼容路径，不能把 v1 命令当成 v2 更新。

## 回复信封

```json
{
  "protocol": "jigerpg-ai",
  "version": 2,
  "packetType": "initialize",
  "campaignId": "原样回传导出值",
  "exchangeId": "原样回传导出值",
  "displayRevision": 0,
  "payload": { "decisionId": "稳定且唯一的决定ID", "initialization": {} }
}
```

初始化使用 `packetType:"initialize"`，后续使用 `packetType:"update"`。程序生成交换 ID，回复回传展示版本；整包相同的决定 ID 重导不执行，换内容或换信封被拒绝。后续有实质展示变动或玩家行为时，旧回复失效；草稿保存、个人头像和公开名单属于元数据，不使原交换失效。服务器仍通过常规 `state.rev`、操作收据和原子事务保存这些操作。

## 初始化五组

`payload.initialization` 必须同时包含：

| 字段 | 结构 |
| --- | --- |
| `freedom` | 房主已选择的 `A` / `B` / `C`，AI 不能修改 |
| `rules` | `{edition:"5e2014"|"5e2024",moduleId?,title?,fields:{...}}` |
| `pcs` | PC 实体数组；只允许 `kind:"pc"` |
| `background` | `{fields:{summary:字段,factions:字段,...}}`，用结构化 JSON 保存背景，不要求某个固定游戏数值 |
| `setting` | `{fields:{...},entities?:实体数组,map?:地图}`；此处实体只能是 NPC、敌人、物品或地标 |
| `opening` | `{fields:{...},narratives?:叙事数组}` |

`fields` 的每一项为 `{value:JSON值,source:"module"|"ai"|"unknown",visibility?:"public"|"private"|"gm",audience?:PC_ID数组}`。`source` 是来源声明，不能证明 AI 已逐字核对模组；房主在采用导入包时审核 module 来源内容。

- **A**：按既定 script；AI 补充逐项留在房主私有待确认列表，确认前展示 `null` 或空白；unknown 留空。确认可以采用或拒绝，拒绝后继续留空。
- **B**：保持主要剧情和既定事实，允许补充细节，无需逐项确认。
- **C**：允许即兴改动发展剧情，保持已确认事实与因果连贯，无需逐项确认。

不支持的 edition 在预览时明确报错，`ai.display.draft.save` 仍可原样保存原文，包括不完整 JSON，不会强行转成 2024 或丢失输入。

## 实体、叙事与地图

实体字段为：

```json
{
  "id": "稳定ID",
  "kind": "pc",
  "name": "名称",
  "source": "module",
  "visibility": "public",
  "fields": {
    "hp": {"value":{"current":-3,"max":10},"source":"ai"},
    "background": {"value":"角色自己的背景","source":"module","visibility":"private","audience":["稳定ID"]}
  }
}
```

`kind` 可为 `pc|npc|enemy|item|landmark`。可选 `position:{x,y}` 是底图归一化坐标，通常在 0 到 1 内；平台不夹紧或计算距离。可选 `image` 支持 HTTPS、安全 `data:image` 或 `/api/assets/<ID>`。地图为 `{width,height,image?,visibility,audience?}`，width/height 是正的有限技术尺寸。

地标采用 `kind:"landmark"`，可把分类放入 `fields.landmarkType.value`，例如 `door`、`trap`、`container`、`location`。没有 position 的公开地标仍可浏览其资料；地图只在房主放置后绘制标记。隐藏实体及私有地图在服务端投影中移除，不提前下发图片 URL。

叙事为 `{id,text,source,visibility,audience?,actorIds?}`。背景、开幕、实体字段、叙事和底图的私密性均由服务器过滤。`private` 的 audience 使用稳定 PC ID，实际收件人由程序可信的成员绑定决定；AI 无权写 bindings 或成员所有权。

PC 的名称、头像和位置是可见实体的最小展示资料。**其他玩家默认收不到该 PC 的完整 fields**。本人可见的非房主秘密字段由本人决定是否公开；包括本人私有背景也可主动分享。`gm` 字段即使本人也看不到，不能通过公开开关泄露。

## 后续更新

```json
{
  "decisionId": "stable-update-id",
  "patches": [
    {"op":"upsert","target":"entity","id":"实体ID","value":{"id":"实体ID","kind":"enemy","name":"敌人","source":"ai","visibility":"public","fields":{}}},
    {"op":"delete","target":"narrative","id":"旧叙事ID"}
  ]
}
```

`upsert` 提供完整实体或完整叙事，替换对应记录；不是合并任意 `state`。`patch.id` 必须等于 `value.id`。稳定 ID 不能直接变更实体 kind。任何一项结构或引用失败时整包回滚。删除绑定 PC 会解除该绑定；仍被私有受众引用的 PC 须连同相关受众修订一起处理。

## 展示命令

| 类型 | payload 与权限 |
| --- | --- |
| `ai.display.draft.save` | `{raw}`，仅房主，原文草稿 |
| `ai.display.freedom.set` | `{freedom}`，仅房主，初始化前 |
| `ai.display.initialize` / `ai.display.apply` | `{packet}`，仅房主，采用预览后的回复 |
| `ai.display.select` | `{actorId}`，玩家直接领取一个未被他人领取的可见 PC，无审核步骤 |
| `ai.display.bind` | `{memberId,actorId}`，仅房主，真实成员 ID |
| `ai.display.release` | `{}`，解除本人绑定 |
| `ai.display.profile` | `{image?:安全URL或null,publicFieldIds?:字段名数组}`，仅真实绑定 PC 本人；头像覆盖独立保存，AI 更新不会覆盖本人选择 |
| `ai.display.action` | `{actorId,type?:"action"|"dialogue"|"explore"|"other",text,targetIds?}`，只允许本人的真实绑定 PC；程序填入真实 memberId 和 untrusted 标记 |
| `ai.display.field.confirm` | `{id,accept}`，仅房主，处理 A 模式单项补充 |
| `ai.display.roll` | `{sides,count,purpose?}`，仅房主；面数 2–1,000,000，数量 1–1000；只输出 faces，不提供总和、命中、伤害或成功判定 |
| `ai.display.entity.position` | `{id,position:{x,y}或null}`，仅房主，只改位置 |
| `ai.display.map.set` | `{map:地图或null}`，仅房主，只改底图技术数据 |
| `world.start` | `{}`，仅房主，初始化成功后开始展示世界；不运行旧统一回合引擎 |

玩家的行为文本以不可信数据导出，不会直接变成命令。提示词明确区分越权元指令与合法角色调查；平台没有“答案”“秘密”等敏感词黑名单。AI 输出仍须房主预览采用，提示词隔离不等于保证外部模型永不出错。

## 技术边界

JSON 仅允许有限数字、字符串、布尔、null、数组和普通对象。保留正常中文、tab、CR、LF；拒绝其他 C0 控制字符和 DEL，错误给出 `AI_JSON_CONTROL` 与 JSON pointer。结构 ID 还不能含任何控制字符或使用 `__proto__`、`constructor`、`prototype`。不检查游戏意义上的属性范围、生命上下限或数值合理性。

包大小限制 8 MB、深度 40、节点 200,000，并对数组和长文本施加技术容量限制；这些限制不代表规则内容已被本地引擎验证。

## Schema 和示例

- [完整 v2 JSON Schema](../reference/ai-display-reply-v2.schema.json)
- [A 初始化：保留待确认原始数值](../examples/ai-v2/initialize-A.json)
- [B 初始化](../examples/ai-v2/initialize-B.json)
- [C 初始化](../examples/ai-v2/initialize-C.json)
- [运行时稳定 ID 更新](../examples/ai-v2/update.json)

示例信封 ID 必须替换为当前世界导出的真实值。`exportAiDisplay(...,"initialize",ctx)` 同时返回完整 `template`，导出包也含 `payload.replyTemplate`；模板的 freedom 保持房主选择，未知数值为 null，不擅自生成默认属性。
