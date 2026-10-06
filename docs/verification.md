# 验证记录 · dsh-plugin-skill-autoroute v1.0.0

环境
- 日期：2026-10-07（Asia/Shanghai）
- Host：DeepSeek Harness 桌面端，profile `desktop`（`<DSH_PROFILE_DIR>`），`patchReload: live`
- Node（宿主自带运行时）：v24.21.0
- 技能池：一个真实工作区技能根（磁盘 47 个目录），Host 运行时目录 **49 项**（含 2 个非文件系统来源）
- 代码：本仓库（commit 前状态，工作树）

---

## 1. 离线单元/回归测试

命令与结果（工作目录 = 插件仓库根）：

```
node --test "test/*.test.mjs"
ℹ tests 30
ℹ pass 30
ℹ fail 0
ℹ duration_ms 109.31
```

| 文件 | 数量 | 覆盖内容 |
|---|---|---|
| `test/router.test.mjs` | 16 | 分词/复数归一、中英桥接、别名解析、显式点名优先、中文命中英文描述、政策播种、元技能降权/提升、格式词剔除、静默规则、确定性、topN、pins、文案契约、配置强制转换、索引复用 |
| `test/plugin.test.mjs` | 10 | 一条指令恰好注入一次、同批不重复/新批再路由、非指令/斜杠/超短输入不注入、`load` 模式注入正文与回退、`router` 模式强制一次/缺失回退/首选列表/空目录不注入、目录读取异常不破坏步骤、`skills/change` 失效缓存、关闭时零挂载、消息构造回退契约 |
| `test/calibration.test.mjs` | 4 | frontmatter 读取、文件系统目录投影、调参集回归、留出集回归 |

> 2026-10-07 追加改动：`routerSkill`（单数）升级为 `routerSkills`（候选列表，取第一个已安装的），空目录不再注入指令；上述 30 项已在该改动后全绿。

## 2. 真实技能池上的路由准确率

打分路径与运行时完全一致（`lib/router.js`），只是目录来自文件系统。

| 集合 | 用例 | 首选命中 | 入选(Top3) | 静默用例 |
|---|---|---|---|---|
| `test/fixtures/calibration.txt`（调参集） | 20 打分 + 2 静默 | **20/20 (100%)** | 20/20 (100%) | 2/2 |
| `test/fixtures/holdout.txt`（留出集，调参后一次未改地跑） | 12 打分 + 2 静默 | 首次 **7/12 (58.3%)** → 词汇补充与同域播种后 **11/12 (91.7%)** | 首次 8/12 → **12/12 (100%)** | 2/2 |

诚实说明：
- 留出集的首次成绩（58.3% / 66.7%）说明「按调参集调好的词表」并不能自动泛化；后续 11/12 是在看过留出集失败项之后补的**通用词汇与同域规则**（`录音/转录/时间轴/汇总/治理/迭代/哪些…`、转写与插件盘点两条同域规则）。这是有意公开的调参过程，不是一次成型的泛化成绩。
- 留出集唯一未命中首选：「把 Obsidian 笔记整理成对外发布的文档包，要能追溯到原始出处」→ 首选 `obsidian` 而非 `game-audio-knowledge-publisher`（正确答案仍在 Top3 内）。原因见 README §6.3：用户显式点名技能的优先级高于意图推断。

复现命令：

```powershell
node scripts/route.mjs --batch test/fixtures/calibration.txt
node scripts/route.mjs --batch test/fixtures/holdout.txt
node scripts/route.mjs "把这次的会议录音做成可继续修改的评审工程，加字幕和候选标记" --notice
```

## 3. 安装（写进 profile 的实际改动）

```
plugin_manager install_bundle target="link:<path-to-this-repo>"
→ {"stage":"enable","target":"dsh-plugin-skill-autoroute","enabled":true,"changed":true,
   "application":"applied","packageResult":{"exitCode":0,...}}
```

profile 侧生效结果：
- `<DSH_PROFILE_DIR>/package.json` → `dependencies.dsh-plugin-skill-autoroute = "link:<path-to-this-repo>"`，且 `dsh.profile.bundles` 追加 `dsh-plugin-skill-autoroute`
- `node_modules\dsh-plugin-skill-autoroute` → 指向仓库的链接存在
- 既有插件（`@nanmicoder/dsh-skills-hub`、`@nanmicoder/dsh-agent-teams`、`dsh-plugin-restart`、`dsh-knowledge-console`）安装后仍然存在，未被本次操作破坏

加载器视角（`cordis_inspect_query` → Config）：
- `include:dsh-plugin-skill-autoroute`，`patchId: dsh-plugin-skill-autoroute`，`packageDir` 已解析为 profile 内链接路径；`status: absent` 表示该行**未声明 Config schema**（与已知可用的 `dsh-plugin-restart` 行完全一致），不代表未加载
- 未重启进程即生效（profile `patchReload: live`）

## 4. 运行时行为（决定性证据）

探针：向一个子会话下发一条典型业务指令，随后解码该会话的持久日志（`zstd` 多帧，逐帧解压）。

命令：

```powershell
node <probe> "<DSH_HOME>\sessions\<workspace-key>\<child-session-id>\session.v4.jsonl.zstd"
```

会话日志中实际写入的事件（原样摘录，`seq:12`，`surfaceOp: "append"`）：

```json
{"type":"user/message","seq":12,"time":1791303980272,"data":{"content":[{"type":"text",
"text":"[skill-autoroute] 已对本地技能目录（49 项）自动完成一次技能路由，候选如下：\n1. premiere-sound-review-editor · 0.99 — Build or continue long-form Chinese game-sound-review projects in Adobe Premi…\n   命中：sound (名称)、review (名称)\n2. sound-review-video-pipeline · 0.97 — …\n3. narrated-game-audio-video · 0.86 — …\n用法：若第 1 项确实匹配当前任务，先调用 skill(name=\"premiere-sound-review-editor\") 读取完整说明再动手；不匹配则忽略本条、按常规执行。不要复述本条内容。"}],
"source":{"kind":"skill-autoroute","form":"notice","summary":"Skill routing: premiere-sound-review-editor, sound-review-video-pipeline, narrated-game-audio-video"},
"id":"a7c995ac-1f6b-4e7f-ab5e-16fb93f5e277","role":"user"}}}
```

结论：
1. 插件已在**运行中的 Host** 内激活（无需重启）。
2. 每条用户指令（`source.kind === 'user'`，子会话亦适用）触发**恰好一次**路由；同一批消息只注入一次（日志中 `user` 来源 2 条、注入 1 条）。
3. 注入物是**持久化**的 user 角色消息（进入会话日志、成为模型请求材料），带生产者标签 `kind: skill-autoroute`，`form: notice` + ≤120 字摘要，因此不会被本插件再次当作指令、也不会干扰既有消费者。
4. 排序符合预期：中文指令命中英文技能名（`sound`/`review` 来自桥接词典），冠军 0.99。
5. 运行时目录规模 49 项（离线文件系统口径 47 项）——插件读的是 Host 服务，因此自动包含非文件系统来源的技能。

## 5. 真实人类回合（2026-10-07 00:33）

用户在知识库会话中发出一条关于本插件的指令，该回合**第一步即带上注入消息**（原文摘录）：

```
[skill-autoroute] 已对本地技能目录（49 项）自动完成一次技能路由，候选如下：
1. skill-selector · 0.97 — 技能太多不知道该用哪个，每次都要翻半天？…
   命中：skill-selector (名称)、selector (名称)、skill (名称)
2. skill-finder-cn · 0.94 — …
3. plugin-first-capability-reuse · 0.80 — …
用法：若第 1 项确实匹配当前任务，先调用 skill(name="skill-selector") 读取完整说明再动手…
```

含义：人类回合这一路径（`agent/pre-step` + `source.kind === 'user'`）与子会话同构，已在真实输入上确认；并且该输入同时命中了「显式点名」与「元指令按意图提升」两条政策（`skill-selector` 得 0.97）。

## 6. 未验证/边界

- `mode: load` / `mode: router` 只做了离线单元验证（`test/plugin.test.mjs`），未在活 Host 上跑（未改运行配置，避免影响用户当前配置）。
- 未验证 agent preset 私有层的技能是否可见（插件调用 `ctx.skills.list()` 未带 `scope`，见 README §6.1）。
- 未做 Windows 之外平台的验证（插件本身无平台相关代码）。
- 运行时目录规模 49 项来自实测；若技能池变动，`test/calibration.test.mjs` 的阈值仍需重新对照（该测试会在池子变动后重新计算，不必改代码）。

## 7. 热更新能力实测（2026-10-07）

用「临时标记 + 探针子会话 + 解码其持久日志」的方式，分别测了三类改动的生效路径。

| 改动 | 操作 | 观测 | 结论 |
|---|---|---|---|
| 新增 bundle | `install_bundle` | 安装后第一次路由即注入通知 | **热生效** |
| profile patch 的 `config: { topN: 1 }` | 只改文件 | 通知仍列 3 个候选 | 手改 patch **不会**被自动重读 |
| 同上 | 改文件 + `set_plugin(enabled=false→true)` | 通知只列 **1** 个候选 | **toggle 触发即热应用** |
| 插件源码（通知文案插 `HMR-PROBE`） | 改文件 / 改文件 + toggle | 两次探测都读不到标记 | 源码改动需**重启 DSH**；toggle 只重跑 `apply()`，模块仍在缓存 |

所有临时改动均已还原：`HMR-PROBE` 标记已移除，profile patch 末尾恢复为 `- id: dsh-plugin-skill-autoroute` / `disabled: false`（实测还原后通知恢复 3 个候选），源码在还原后 `node --test` 仍 30/30 通过。

## 8. v1.1.0：候选上限可配置 + 三项顺手修（2026-10-07）

用户反馈「候选上限需要可配置」，同时允许自由优化，于是本轮改动：

| 改动 | 之前 | 现在 |
|---|---|---|
| 简报里的候选条数 | `topN`，上限 10 | **`candidates`，1–25**；`topN` 作为旧名仍接受 |
| 一次路由扫描的技能数 | `maxCandidates`，上限 5000 | **`catalogLimit`，1–20000**；`maxCandidates` 作为旧名仍接受 |
| 简报体积 | 固定带「命中：」证据行 | **`explain: false`** 去掉证据行（同一候选表，更省 token） |
| 候选资格 | 目录里所有技能 | **只取 `invocation.modelInvocable !== false`** 的技能——不能再推荐一个 `skill` 工具会拒绝的技能 |
| 组合诊断 | 无 | 挂载时若组合里没注册 `skill` 工具，打一条 warning（只记日志，不阻断） |
| 挂载日志 | `armed (mode=…, topN=…)` | `armed (mode=…, candidates=…, catalogLimit=…, …)` |

证据：
- `node --test "test/*.test.mjs"` → **33/33 通过**（新增：候选上限与旧名别名、`catalogLimit` 边界、`explain` 文案契约、不可调用技能必须沉默、`candidates: 1` + `explain: false` 端到端）。
- 旧名兼容在测试里固定：`resolveConfig({ topN: 4 }).candidates === 4`、`resolveConfig({ maxCandidates: 9 }).catalogLimit === 9`，且解析结果里**不再出现** `topN`/`maxCandidates` 字段。
- **运行中的 Host 仍是 1.0.0 代码**：本轮改的是源码，按 §7 的实测结论需要**重启一次 DSH** 才能用上新配置键；在那之前 patch 里写 `candidates` 不会生效（旧代码只认 `topN`）。
