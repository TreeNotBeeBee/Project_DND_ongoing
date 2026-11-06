# 手动使用 ChatGPT 主持

协议版本：`jigerpg-ai / 1`。AI 主持模式采用“导出上下文 → 复制给外部 AI → 导入 JSON → 房主预览确认”的流程。平台不绑定模型 SDK，也不会自动发送私人数据给模型服务。

## 房主操作流程

1. 新建 **AI 主持**世界，在设置中选择“程序骰”或“AI 骰”。世界运行后的骰源切换受到服务器限制：不能在未完成的反应、AI 续接或已经结算的本轮骰子之间切换。
2. 准备阶段导出初始化包，将界面给出的 **提示词、上下文包、JSON Schema** 一起交给 ChatGPT。可以要求自由角色、空技能、空装备，不需要指定职业或背景；标准 5e 卡仍需满足自己的标准建卡规则。
3. 要求 AI 只回复一个 JSON 对象。导入前先检查预览中的角色、规则、物品、属性改动和经验数量，再由房主确认。初始化生成的主角卡处于“可领取”状态，暂由房主管理并隐藏；AI 无权替玩家领取或注册。
4. 进入世界后，玩家提交行动意图，确认“结束回合”。本轮固定名单中的在线参与者全部结束后，房主才能导出回合上下文；中途加入者等待下一回合。
5. AI 对每个意图明确批准或拒绝。批准会立即使用选定骰源结算，并按采用的规则扣行动力、法力和体力。`completeRound:true` 要求本轮已结束玩家的全部待处理意图均有决定；成功后进入间歇，再开始下一回合。
6. 出现护盾术等反应时，剩余步骤暂停，玩家在平台选择。服务器持久保存续接位置，重启后可继续；不会重复支付原行动费用。AI 骰不足时平台保留玩家选择，房主重新导出上下文并补交所请求的骰子。

导出给 AI 的内容包括世界公开背景、房主秘密背景、角色可执行数值与行动、场景、待处理意图和已审计骰子。**角色私人笔记、原始旧存档、成员恢复凭据和玩家私有草稿不进入协议上下文。** `story` 是可用于故事的内容，`notes` 是私人笔记；不要把现实隐私放入需要发送给外部 AI 的世界背景。

## 文件与示例

- [完整回复 JSON Schema](../reference/ai-reply.schema.json)
- [初始化](../examples/ai/initialize.json)
- [程序请求掷骰](../examples/ai/program-roll-request.json)
- [程序骰回合决定](../examples/ai/program-decision.json)
- [AI 骰回合决定](../examples/ai/ai-decision.json)
- [反应补骰](../examples/ai/reaction-supplement.json)
- [NPC、奖励和自由数值裁定](../examples/ai/runtime-rulings.json)

示例中的 `example-campaign`、`example-exchange`、`hero-id`、`intent-id`、`choice-id` 必须替换为本次导出包中的真实标识。不能把示例当成某个正在运行房间的存档直接导入。示例由自动测试调用实际 `parseAiReply` 验证，Schema 由同一套 Zod 定义生成。

## 固定信封

所有包都有以下字段，不允许额外顶层字段：

| 字段 | 含义 |
| --- | --- |
| `protocol` | 固定 `"jigerpg-ai"` |
| `version` | 固定 `1` |
| `packetType` | 程序导出 `initialize`、`player_selection`、`turn_context`、`roll_results`；AI 回复只能为 `initialize` 或 `decision` |
| `campaignId` | 原样回传导出包的世界 ID |
| `exchangeId` | 原样回传程序生成的本次交换 ID，不能自行编造 |
| `worldRevision` | 原样回传世界玩法版本；头像等外观变动不使回复失效 |
| `payload` | 对应包的有效载荷 |

每个回复必须有 `payload.decisionId`，由 AI 为该决定选定稳定、唯一的 ID。原包以相同 ID 再次导入不再执行；同 ID 修改内容或换一个交换信封会被拒绝。奖励不能通过重发同一决定重复领取。

世界玩法已经改变时，旧回复会被拒绝，必须重新导出。已确认且正在等待反应的私有续接会在原确认范围内恢复；无需让 AI 重新决定已支付的步骤。程序只接受规定的增量效果，不接受整份 `state` 替换、成员所有权、治理、恢复或备份命令。

## 初始化回复

`packetType:"initialize"` 仅在准备阶段有效。`payload` 字段如下，除 `decisionId` 外均可省略：

| 字段 | 内容 |
| --- | --- |
| `decisionId` | 稳定决定 ID |
| `lore` / `secretLore` | 世界公开背景 / 房主秘密背景 |
| `scene` | `width,height,gridFeet:5,fog,walls,terrain`，可选背景图；墙包含 `id,a,b,door?,open?`，地形包含 `id,x,y,width,height,type` |
| `rules` | 完整世界规则，见下表 |
| `characters` | 可领取主角输入数组 |
| `npcs` / `monsters` | NPC 输入数组；不会生成玩家席位 |
| `items` | 世界物品定义数组 |
| `nodes` | 资源节点数组 |
| `npcBehaviors` | NPC 行为定义数组，角色引用可使用上述输入的外部 `id` |

角色输入可使用 `id,name,profile,kind,monsterId,abilities,manual,hp,resources,classes,speciesId,backgroundId,skills,expertise,saveProficiencies,languages,spells,features,customActions,story,notes,portrait,position,hidden,size,choices,resistances,immunities,vulnerabilities`。完整类型和上限见 Schema；所有权和注册状态由程序生成。

自由卡 `profile:"free"` 默认六维 10、生命上限 10、基础 AC 10、速度 30、熟练 0；职业、技能、装备可以为空。`manual` 可写 `maxHp,proficiency,ac,speed`，基础 AC 不自动叠敏捷。能力值允许高于 30，仍需有限数值并满足技术边界。资源对象为 `{id,name,current,max,recovery}`；内置资源 ID 是 `mp,stamina,shield,ap`，恢复枚举 `manual|short|long|turn`。初始 AP 只能为 0，由世界开始时按采用的行动力规则发放；AI 不能自报初始 AP。

自由行动 `customActions` 使用原生 `ActionDefinition`，`source:"custom"`。常用字段是 `id,name,economy,range,reach,attack,save,damage,healing,healingAbility,castingAbility,costs,conditions,targets,area,description,automation`。命中使用 `attack.ability` 或明确 `attack.bonus`；每段伤害的 `addAbility` 独立设置，不会默认把同一个属性同时用于命中和伤害。动态豁免 DC 必须有明确 `castingAbility` 或攻击属性，否则填写固定 `save.dc`。属性键为 `str|dex|con|int|wis|cha`。

伤害类型为 `acid,bludgeoning,cold,fire,force,lightning,necrotic,piercing,poison,psychic,radiant,slashing,thunder`。物理/法术来源与这 13 类伤害不能互相替代。伤害按抗性等调整后，依次消耗独立 `shield`、临时生命和生命；不会将所有法术伤害合并成一种“魔法伤害”。

| 世界配置字段 | 内容 |
| --- | --- |
| `rules.energy?` | `{maximum,perRound,recoveryMode:"hour"|"round",recovery,initial?}`；基础上限不超过 100 |
| `rules.costs` | 可选 `move,action,narrative,proposal`；移动成本按格及困难地形/爬行计算 |
| `rules.conflict` | `{kind:"random"|"cancel-refund"|"attribute",attribute?}` |
| `rules.growth` | `{kind:"global"|"tracks",tracks:[{id,name,curve,pointsPerLevel,upgrades:[{target,cost,amount,max?}]}]}` |
| `rules.recipes` | `[{id,name,description,cost,inputs,outputs,experience,resourceCosts?,durationRounds?,unlockEntries?}]` |
| `rules.proposalHours?` | 投票期限，小时 |
| `items` | `[{id,name,description,bonuses?}]`；加成键为六维、`hp,mp,stamina,ap.maximum,ap.recovery,ap.perRound` |
| `nodes` | `[{id,name,position,inventory:[{itemId,quantity}],hidden?}]` |
| `npcBehaviors` | `[{actorId,kind:"idle"|"patrol"|"hostile"|"trade"|"event",waypoints?,targetKinds?,actionId?,ruleId?,trigger?}]` |

AI 回合只执行回复包内的明确 NPC 行动，不会在回合结束时再运行一遍程序 NPC 策略。成长 `upgrades.max` 限制该项累计加成，不是角色最终属性值。

## 决定步骤与裁定边界

`packetType:"decision"` 的 `payload` 包含 `decisionId`、可选 `completeRound`、`narratives:[{text,actorIds?}]`、`steps` 和 `aiRolls`。

步骤的 `id` 在本包内唯一，按数组顺序执行：

| 步骤 | 字段与用途 |
| --- | --- |
| `type:"intent"` | `intentId,approve,rollId?`；批准后立即执行原意图，不能修改玩家提交的目标、路径和资源成本；拒绝不扣费用 |
| `type:"command"` | `command:{type,actorId?,targetIds?,payload?},rollId?`；仅允许下表中的效果命令 |
| `type:"ruling"` | `command`；只允许 `gm.adjust,effect.add,effect.remove,character.patch,growth.award,world.configure`，明确记录为外部裁定 |
| `type:"roll"` | `expression,rollId`；请求通用掷骰，不自动代替某次攻击/伤害结算 |

`completeRound:false` 用于分步交换。未填写时，若这是回合上下文回复、没有请求程序掷骰、所有已结束玩家的意图均终结且没有其他 AI 续接，默认完成回合。显式 `true` 缺少任何待处理意图的决定会整包失败。

| `command.type` | `payload` 白名单 |
| --- | --- |
| `action.use` | `actionId,slotLevel?,origin?,advantage?,options?`；动作必须是该角色可用的原生或自定义动作 |
| `actor.move` | `path:[{x,y}]`，路径不含当前起点 |
| `actor.rest` | `kind:"short"|"long",hitDice?` |
| `actor.deathSave` | 空对象 |
| `actor.create` | 上述角色输入；运行中只创建 NPC，`payload.id` 是外部别名，后续步骤可用它引用新角色 |
| `inventory.add` | `contentId,quantity?,baseContentId?,variant?`；只能发放已存在的世界物品或发布目录中的装备/魔法物品/毒药 |
| `inventory.equip` | `itemId,equipped,attuned?` |
| `inventory.consume` | `itemId,options?` |
| `knowledge.unlock` | `entryId`；只解锁该角色的已存在图鉴或 `world:<物品ID>` |
| `character.patch` | `patch` 仅允许 `abilities,manual,hp:{current?,temp?},resources,customActions,skills,expertise,saveProficiencies,resistances,immunities,vulnerabilities,size`；只限自由卡，不能改变 AP |
| `growth.award` | `awards:[{trackId,amount}]`；角色 ID 放在 `command.actorId`，经验按当前成长曲线结算，不能直接填等级或点数 |
| `world.configure` | `lore?,secretLore?,rules?,items?,nodes?,npcBehaviors?`；提供目录数组时替换该目录，已有库存/任务引用仍须有效 |
| `gm.adjust` | `hp?,temp?,resourceId?,resourceDelta?,condition?,exhaustion?`；`hp` 是当前生命的绝对值，`resourceDelta` 是资源增减量，不支持 `maxHp` |
| `effect.add` / `effect.remove` | `{effect:{name,condition,duration?}}` / `{effectId}` |
| `choice.resolve` | `choiceId,optionId,ruling?`；不能替玩家选择反应，仅可兑现玩家已明确选择但等待 AI 补骰的同一个选项 |

在配置了 AP 的运行世界中，主角的普通行动、移动、装备切换必须通过玩家意图结算。直接命令不能绕过 AP；现有意图尚未提供休息、饮用物品、死亡豁免类型，这三类主角直接命令也会明确拒绝。NPC 的明确普通命令转换为受信任系统意图，按行动/移动成本扣费，并计入每轮额度。外部裁定用来表达陷阱、环境、奖励等具体世界事实，房主应审核其原因，不能把普通行动改写成随意改生命以规避规则。

目录中尚未支持的确定性 SRD 机制会阻止执行。需要主持人判断的开放叙事必须由房主审核，不能把 AI 写出的解释视为程序已经实现该规则。

## 程序骰与 AI 骰

**程序骰**：AI 不可提交 `aiRolls`。批准的动作/意图由服务器骰源结算，实际骰面记录在审计事件中。若 AI 需要先知道一个通用检定结果，应提交 `roll` 步骤，之后本包只能继续请求骰子；导入后导出 `roll_results`，把真实结果交回 AI，再导入后续决定。通用 `roll` 不会自动扣除攻击费用或代替后续攻击中的骰子，不能通过手填伤害来宣称完成自动战斗。

**AI 骰**：每个会请求随机数的 `command` 或 `intent` 用 `rollId` 指向本包一个 `aiRolls`，每个骰池只能有一个用途：

```json
{"id":"attack-dice","expression":"1d20+1d6","rolls":[12,4],"total":16}
```

这是原始骰池，不包含引擎负责计算的命中/属性加值。平台逐一检查骰子数量、每面范围、表达式总和以及引擎实际请求顺序；例如命中后需要 `d6`，不能提供另一个 `d20`。未消费的多余骰子被拒绝；攻击未命中时不要附带不会使用的伤害骰。AI 骰不是可验证的随机源：平台能验证合法范围及用途，不能证明外部 AI 公平随机。房主需要不可由 AI 决定的随机性时选程序骰。

护盾等反应会改变后续需要的骰子。平台暂停并把剩余骰池保存在房主私有交换记录，玩家收到的选择中只有不透明引用，不会看到将来的骰面。缺骰时导出的 `pendingDice` 给出 `choiceId,optionId,side`；补包只提交这一条匹配的 `choice.resolve` 和新骰池，不能改变玩家已选选项。完成后程序恢复原包的剩余步骤，不重扣费用。

非法字段、过期版本、错误骰子或执行失败都会拒绝当前事务，不留下本包前面步骤的部分状态。已经完成并保存的玩家反应不会因后续续接失败而撤回；平台会记录续接失败，房主需导出新上下文修正。

## 本地接口

```ts
createAiExchange(state, kind, ctx) // {state,packet,schema,prompt}
previewAiPacket(state, packet, ctx) // {valid,errors,summary,packet?}
applyAiPacket(state, packet, ctx) // Resolution
resolveAiGameCommand(state, command, ctx) // 受信任房主增量效果入口
resolveAiReaction(state, command, dice, resolveEngine) // 服务器反应入口
resumeAiDecisions(state, ctx) // 服务器完成反应后续接已确认包
```

`ctx` 包含房主身份、当前成员/在线名单、服务器时间、骰源、引擎构造/验证/派生函数和世界命令解析器。权限、数据库事务、操作去重及版本号由服务器维护。AI 的命令选项不能注入内部骰子、`skipResources` 或物品免消耗标志。
