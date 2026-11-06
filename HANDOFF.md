# JigeRPG 开发交接

本轮聚焦 **本机账号与多个世界、DND 的 AI JSON 主持、简洁玩家地图**。真人主持和自由共创保留，暂不扩展。用户明确要求：小步验证、小步本地 Git 提交，收尾将交接与源码一起发布到 `TreeNotBeeBee/Project_DND_ongoing`。

## 在另一台电脑接手

1. 克隆仓库或从 GitHub 下载 ZIP 后解压。根目录应直接包含 `package.json`、`src/`、`scripts/`、`runtime.json` 和本文件。
2. Windows x64 双击 `启动JigeRPG.cmd`。首次需要联网下载项目私有 Node 26、锁定依赖、Cloudflare 工具并构建；不会替换系统 Node。
3. 只做本机开发可运行 `启动JigeRPG.cmd -LocalOnly`。不需要程序替你打开浏览器时加 `-NoOpen`，按启动窗口给出的地址自行打开。
4. 登录账号后进入「开始 / 新建 / 基础设置」。新建 AI 世界按 [AI 指南](docs/AI_DISPLAY_V2.md)导入初始化数据。邀请入口仍在世界内部。

**GitHub 只含源码和公开示例，不含战役、账号数据库、密码摘要、恢复码或凭据。** 如果还要转移实际存档，先关闭旧电脑的主机进程，再私下复制整个 `data/` 到新电脑；也可以使用带清单的一致性数据库备份。不要把数据库上传到公开仓库。详细步骤见 [BACKUP.md](docs/BACKUP.md)。

## 当前架构和约束

- React / TypeScript / Vite 前端，Koa + WebSocket，SQLite 持久保存。依赖锁定在 `package-lock.json`；下载校验见 `runtime.json`。
- 运行时版本 `2.0.0-beta.2`，数据库结构版本 **3**。新增本机账号、账号会话与世界成员关联；旧成员和旧恢复码保持原 ID。
- 新 AI 世界用 **展示协议 v2**，与原生 `Actor` 和规则引擎分离。不能把 AI 数据送进 `executeEngine`、`deriveActor` 或标准建卡校验。AI 数值可为 0、负数、超过最大值；程序只检查技术格式与权限，不校验游戏合理性。
- 自由度 A / B / C 由房主决定。A 的 AI 补充字段等待逐项接受或留空，B / C 无此门槛。来源标签是声明，不是事实核验。
- 当前只支持 `5e2014` / `5e2024` 初始化元数据；不支持版本应提示并保留草稿，不转换规则版本。
- 账号独立于世界；世界仍使用自己的 member ID，所有角色归属与审计引用此 ID。关联旧身份只能凭原有效会话或恢复码，不能按名字合并。
- 服务器必须过滤公共、指定角色私有和主持秘密。玩家行为绑定真实身份并作为不可信 JSON 数据导出；不能把玩家文字插入固定主持指令。手动 ChatGPT 往返不具有 API Structured Outputs 的服务端保证。
- 地图与头像展示不执行游戏规则。移动只提交意图，AI 更新真实位置；相机回归和隐藏玩家只改变本地视图。
- 不恢复退役 `origin/` 源码目录；保留 Git remote `origin` 指向用户指定仓库。

## 代码位置

| 位置 | 职责 |
| --- | --- |
| `src/server/accounts.ts`、`database.ts`、`app.ts` | Argon2id、本机账号会话、世界列表、成员关联、事务及路由 |
| `src/shared/ai-display.ts` | 独立 AI 状态、实体、来源、私密范围、行为和地图类型 |
| `src/ai/display.ts`、`display-schema.ts` | v2 初始化、增量更新、格式限制、提示词、投影与指令 |
| `src/server/ai-display-projection.ts` | 绕开原生规则引擎的 AI 世界快照 |
| `src/client/WorldApp.tsx`、`transport.ts` | 应用分流、账号 / 世界切换、可靠提交 |
| `src/client/WorldHome.tsx` | 登录后的三项主菜单与创建分类 |
| `src/client/AIPlayerMap.tsx`、`ai-map-geometry.ts` | AI 地图、固定大小头像、相机与点击区域 |
| `src/ai/protocol.ts`、`src/engine/`、`src/world/` | 保留的旧 v1 协议、真人 / 自由模式规则；不用于新 v2 数值解释 |

## 测试与本地开发

```powershell
$runtime = Get-Content .\runtime.json -Raw | ConvertFrom-Json
$nodeDir = Join-Path $PWD ('.tools\node-v' + $runtime.node.version + '-win-x64')
$env:PATH = $nodeDir + ';' + $env:PATH
npm run typecheck
npm test
npm run build
```

浏览器测试先运行 `安装或修复环境.cmd -Browsers`。测试必须使用临时数据目录，不能对真实 `data/` 写入。并行开发用独立 worktree，不要在共享 `node_modules` junction 上执行 `npm ci`。不要为了惯用而降级依赖；安装或升级前查询官方当前稳定版本。

验收结果、发布检查点及回退演练在本轮收尾后填入 [VERIFICATION.md](docs/VERIFICATION.md)。

## 后续优先事项

1. 继续用真实模组试跑 v2，改善角色资料和剧情信息的展示；按用户反馈演进 schema 时明确版本迁移。
2. 原高级标准建卡向导仍有用户报告：技能超额仍可勾选、无职业来源的技能未提前禁用、高环 / 无资格法术未置灰、魔法学徒选完后仍提示缺项。AI v2 已避开此强制向导，但不能据此宣称这些旧问题全部修复。
3. 验证旧向导失败的具体表单与待处理队列状态。纯函数曾验证合法的 Light + Sacred Flame + Cure Wounds 可通过，尚不能据截图断言服务器校验本身必然错误。
4. 真人主持与自由共创的专属界面、复杂 SRD 自动化、多场景与完整照明等仍是独立后续任务。覆盖矩阵 `2017` 条、`662 unsupported` 是旧规则目录状态，不表示 v2 需要本地实现这些运算。
5. 防提示词注入依赖权限隔离与清晰数据边界，不能承诺外部 AI 永不出错。若以后接 API，再单独设计秘密上下文、工具权限与结构化返回。

## 数据回退

本轮前代码标签：`before-ai-display-20261106`（`b024552`，schema 2）。升级 schema 3 前会自动生成一致性备份。开发中另已创建正式库的只读一致性备份，原 schema **2**，编号 `a0c4e3e6-0ff0-4281-938d-efff5fd43a2f`；备份工具当时的提交为 `513bd2d`，回退运行应使用支持 schema 2 的 `b024552`，不要把工具提交误当作旧数据库的运行版本。文件保存在本机忽略的 `data/backups/`，不进入 GitHub。

新清单分别记录备份工具的 `gitCommit` / `codeVersion` 与数据库最近运行的 `databaseGitCommit` / `databaseCodeVersion`。配对恢复以实际 `schemaVersion` 为前提，并检查数据库记录的代码版本。

回退时先关闭服务并备份当前数据，切到对应代码，再恢复对应 schema 的数据库；不要用旧代码打开新数据库。`scripts/restore.mjs` 校验清单、SHA256、表结构和外键，拒绝版本不匹配。源码、完整数据库、备份清单应成套保管。
