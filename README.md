# dsh-plugin-skill-autoroute · 技能自动路由

> 收到用户指令后，**自动做一次技能路由**：在 Host 侧按当前指令扫描实时技能目录，产出候选排名，并向该步注入**恰好一条**路由提示。
> 三种模式：候选简报（默认）／自动加载技能正文／强制调用 `skill-router`。

本机技能库有 47 个技能，但 `skill` 工具是**被动**的——模型得自己想起来去查。这个插件把「路由这一步」变成确定性动作：不再依赖模型是否记得，也不再依赖用户是否明说「该用哪个技能」。

---

## 1. 它到底做了什么

每条**用户指令**（`source.kind === 'user'`）的**第一步**，插件会：

1. 从 `agent/pre-step` 拿到这一步将要进入模型的消息；
2. 读 Host 的 `skills` 服务（`list()`），拿到当前作用域可见的技能目录；
3. 用确定性算法（不是 LLM 调用）给技能打分并排序；
4. 把**一条**合成 user 消息追加到这一步：

| 模式 | 注入内容 | `source.form` |
|---|---|---|
| `brief`（默认） | Top-N 候选 + 命中词 + 「若第 1 项匹配就先 `skill(name=...)`」 | `notice` |
| `load` | 若冠军分数 ≥ `loadMinScore`：**连该技能的 SKILL.md 正文一起注入**；否则退回 `brief` | `instructions` |
| `router` | 只注入一句指令：**立刻调用 `skill(name="…")` 恰好一次**（`routerSkills` 里第一个已安装的） | `instructions` |
| `off` | 什么也不注入 | — |

同一批指令只路由一次；轮次中途的新指令（steering）算新的一批。无关指令**保持沉默**（不硬凑候选），这与本地 `skill-router` 的静默规则一致。

注入的消息带生产者标签 `{ kind: 'skill-autoroute' }`，因此不会被本插件自己的触发过滤器误认成用户指令，也不会被后续步骤重复路由。

### 需要先装 `skill-selector` / `skill-router` 吗

**不需要。** 路由能力（打分、中文桥接词典、同域政策表）已经内化在插件里，默认的 `brief` 模式**完全自给**，一个 router skill 都不依赖。

| 模式 | 对外部技能的依赖 | 缺失时的行为 |
|---|---|---|
| `brief` | 无（只读技能目录做排序） | — |
| `load` | 只需**冠军技能本身**存在（它本来就在技能库里）；正文经 `skills.get()` 读取 | 取不到正文就退回 `brief` |
| `router` | 需要 `routerSkills` 里**至少一个**已安装（它只是让模型去调用该技能） | 一个都没装 → 记一条 warning 并退回 `brief`；目录为空 → 不注入 |

`routerSkills` 是**候选列表、取第一个已安装的**，所以 `['skill-selector', 'skill-router']` 在本机两种命名下都能用：

```yaml
- id: dsh-plugin-skill-autoroute
  config:
    mode: router
    routerSkills: ['skill-selector', 'skill-router']
```

技能**正文**（`SKILL.md`）刻意不打包进插件：内容永远由宿主的 `skills` 服务实时提供（`@deepseek-ai/dsh-skill-filesystem` 的 `customSkillDirs`，或 `@nanmicoder/dsh-skills-hub` 的 `skillsRoot` 指向的那个技能根），避免插件内出现第二份会漂移的策略副本。

---

## 2. 挂载点（为什么这样接）

| Host 接缝 | 用途 | 说明 |
|---|---|---|
| `agent/pre-step`（waterfall） | 追加合成 user 消息 | 与 `@nanmicoder/dsh-agent-teams`、`dsh-orb` 同构：`next()` 后 `{...decision, messages:[...decision.messages, notice]}` |
| `skills` 服务 | `list()` 取目录、`get()` 取正文 | 与模型看到的技能目录同源（Host 全局层） |
| `skills/change` 事件 | 失效目录缓存 | 技能增删/更新后立即重读 |

无客户端半边：注入内容走正常对话记录，界面无需改布局。消息构造优先用 Host 的 `createUserMessage`；若运行时无法解析 `@deepseek-ai/dsh-llm`，则使用**结构等价**的本地构造器（同字段、uuid id、deepFreeze），不会让插件整体失效。

---

## 3. 配置

写在 profile 的 patch 层（`<DSH_PROFILE_DIR>/cordis.patch.yml`），后面的层覆盖前面的层；**改完记得按 §5.4 toggle 一次该行**，否则运行中的 Host 不会重读文件：

```yaml
- id: dsh-plugin-skill-autoroute
  config:
    mode: brief          # off | brief | load | router
    routerSkills: ['skill-selector', 'skill-router']
    candidates: 3        # 简报里列几个候选（1–25）
    catalogLimit: 400    # 一次路由最多扫描多少技能
    explain: true        # false = 去掉「命中词」行，简报更省 token
    minScore: 0.28
    loadMinScore: 0.55
    locale: zh           # zh | en
    debug: true          # 每次路由决策打一条 Host 日志
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时整行不挂任何监听器 |
| `mode` | `brief` | 见上表 |
| `routerSkills` | `['skill-router']` | `router` 模式可点名调用的技能，**取第一个已安装的**；单数 `routerSkill: skill-selector` 也接受 |
| `candidates` | `3` | **简报里列几个候选（1–25）**；旧名 `topN` 仍接受 |
| `explain` | `true` | 是否在候选下打「命中：…」证据行；`false` 明显更省 token |
| `minScore` | `0.28` | 低于此分不进入简报；**没有任何候选达标时保持沉默** |
| `loadMinScore` | `0.55` | `load` 模式自动加载正文的门槛 |
| `maxBodyChars` | `6000` | 注入正文的字符上限 |
| `minChars` | `4` | 太短的指令（「好」「继续」）不路由 |
| `catalogLimit` | `400` | **一次路由最多扫描多少技能（1–20000）**；旧名 `maxCandidates` 仍接受 |
| `catalogCacheMs` | `30000` | 目录缓存时长（`skills/change` 会立即失效） |
| `skipSlashCommands` | `true` | 斜杠命令自带行为，不路由 |
| `triggerSources` | `['user']` | 触发路由的消息来源；加 `'agent-teams'` 可让队员任务也路由 |
| `locale` | `zh` | 注入文案语言 |
| `metaDownRank` | `0.45` | 元技能族（`skill-*`／`luban-*`…）在真实业务题上的降权 |
| `rulesEnabled` | `true` | 是否启用本地政策层（元技能、格式词、同域优先表） |
| `lexiconEnabled` | `true` | 是否启用中→英桥接词典 |
| `lexicon` | `{}` | 追加/覆盖桥接词，如 `{ 棱镜: [prism] }` |
| `pins` / `pinMinScore` | `[]` / `0.1` | 常驻优先技能（必须真实存在） |
| `debug` | `false` | 每个决策写一条日志 |

> 切换模式只需改一行 `mode`。**想要「完全不用模型再决定」就用 `load`**（插件自己选中并注入正文）；**想要字面意义的「自动调用一次 skill-select/skill-router」就用 `router`**。

---

## 4. 路由算法（可复核，不是黑盒）

```
fieldWeight(词) = 4（名称/别名） | 2（when_to_use） | 1（description）
idfFactor(词)   = 0.6 + 0.4 × idf(词)/maxIdf      // 稀有词命中更值钱
evidence(词)    = 查询词权重 × fieldWeight × idfFactor
strength        = max(显式点名 8, evidence × 政策系数, 本地优先表下限 3.2) + 意图加分 4.5
排序            = strength 降序
展示分          = 1 - exp(-strength / 3.2)
```

- **中→英桥接词典**（`lib/lexicon.js`，约 180 条）：技能名和描述以英文为主、指令以中文为主，纯词面匹配几乎打不中（`评审` 永远遇不到 `review`）。词典让中文 n-gram 额外投出英文证据词，权重 ×0.85。可用 `lexicon` 配置追加。
- **本地政策层**（`lib/local-policy.js`）：把 `skill-router/references/local-overrides.md` 的规则落成代码——元技能族在业务题降权、在元指令按意图提升；`PDF`/`PPTX` 作为**交付格式**时把同名技能**整个剔除**（F1/F2）；同域优先表（评审工程 / 碎片重排 / 成片流水线 / 转写 / 插件盘点…）给出加成**或直接播种候选**（中文「转成中文字幕」与 `openai-whisper` 零词面交集，只能靠政策播种）。
- **指针不越界**：政策表只会提升/播种**已安装**的技能；名字解析不到就什么也不做。
- **静默规则**：没有任何候选达到 `minScore` 时不注入，避免把噪音塞进上下文。

---

## 5. 安装与验证

### 5.1 安装（推荐走 plugin_manager）

```
plugin_manager install_bundle → target: link:<path-to-this-repo>
```

或手工（等价）：

```yaml
# <DSH_PROFILE_DIR>/package.json → dependencies
"dsh-plugin-skill-autoroute": "link:<path-to-this-repo>"
# <DSH_PROFILE_DIR>/package.json → dsh.profile.bundles 追加 "dsh-plugin-skill-autoroute"
```

然后 `pnpm install`（或让 plugin_manager 代跑）并重启 DSH；`cordis.yml` 不用改（该文件是生成物，patch 层才是编辑点）。

### 5.2 离线验证（无需重启）

要求 Node ≥ 22（`node --test` 自带 glob 展开）。技能根默认取当前目录下的 `.agents/skills`，可用 `SKILL_AUTOROUTE_ROOT` 覆盖。

```powershell
# 33 个单元/回归测试（真实技能池不存在时，两个准确率套件会自行跳过）
node --test "test/*.test.mjs"

# 单条指令看排名与将注入的文案
node scripts/route.mjs "把这次的会议录音做成可继续修改的评审工程，加字幕和候选标记" --notice --root test/fixtures/skills

# 批量跑校准集 / 留出集（期望值写在 fixtures 里；需要有对应技能的真实技能池）
$env:SKILL_AUTOROUTE_ROOT = '<your skill root>'
node scripts/route.mjs --batch test/fixtures/calibration.txt
node scripts/route.mjs --batch test/fixtures/holdout.txt
```

`scripts/route.mjs` 走的是**生产同一条打分路径**（同 `lib/router.js`），只是目录来自文件系统而不是 Host 服务；`test/fixtures/skills/` 是随仓库提交的小型固定池，CI 用它做确定性回归。

### 5.3 上线后怎么确认在工作

- Host 日志：`[skill-autoroute] armed (mode=..., candidates=..., catalogLimit=..., ...)`；`debug: true` 时每次决策一条。
- 只在**可被模型调用**的技能里选（`SkillInvocationPolicy.modelInvocable`）；若该组合没有注册 `skill` 工具，挂载时会打一条 warning。
- 对话记录里出现 role=user、来源 `skill-autoroute` 的一条消息（`form: notice` 或 `instructions`）。
- `mode: router` 时，模型下一步应当出现一次 `skill(name="skill-router")` 调用。

权威结论见 `docs/verification.md`（含本机实测数据与命令输出）。

---

### 5.4 改动如何生效（2026-10-07 实测，别踩坑）

| 你改了什么 | 生效方式 | 实测证据 |
|---|---|---|
| profile patch 里的 `config:`（模式／阈值／候选数／词表） | **手改文件不会自动重读**；再用 `plugin_manager set_plugin` 把同一行 `enabled: false → true` 触发一次即可热应用，无需重启 | patch 写 `candidates: 1` 后直接跑：通知仍是 3 个候选；toggle 之后：**1 个候选** |
| 新增／移除 bundle（安装、卸载） | `install_bundle` / `remove_bundle` **当场热应用**（profile `patchReload: live`） | 安装后第一次路由即出现注入消息，**未重启** |
| 插件源码（`index.js`、`lib/*.js`） | **必须重启 DSH**（侧边栏一键重启）；toggle 只会重新 `apply()`，Node 模块缓存里仍是旧代码 | 在通知文案里临时插 `HMR-PROBE` 标记 → toggle 前后两次探测都读不到该标记 |

结论：**调参/换模式 = toggle 即可；改算法/词表代码 = 重启一次。**

### 5.5 发布（维护者）

流程写在 [`RELEASING.md`](RELEASING.md)：CI 每次 push 都会跑契约检查（`scripts/verify-bundle.mjs`，专抓「装得上但什么都不加载」那类缺陷）并构建一次发布包；只有打 `v*` tag（或手动触发 Release workflow，**默认草稿**）才会真正发布 Release 资产。

## 6. 已知限制

1. **只读全局技能层**：`ctx.skills.list()` 未带 `scope`，因此 agent preset 私有层注册的技能不会进入候选。本机技能都来自 Host 层（`@deepseek-ai/dsh-skill-filesystem` + `@nanmicoder/dsh-skills-hub`），故当前无影响；插件读的是 Host 服务而不是磁盘，所以运行时会看到 49 项（磁盘目录 47 项 + 2 个非文件系统来源）。
2. **不做 LLM 路由**：确定性、零额外模型调用、可离线回归；代价是中文词典和同域优先表需要人工维护（新增技能/新说法时补词）。
3. **显式点名优先**：用户明确说了某个技能名时会压过意图判断（例如同时说「Obsidian」和「出版包」时给出 `obsidian`）。这是 `resolution-order.md`「用户点名优先」的取舍，可用 `pins` 或 `rulesEnabled: false` 调整。
4. **每批指令一次**：同一批消息（同一组 message id）只路由一次，之后不再重复注入；轮次中途的新指令会产生新的一批。
5. **准确率是测出来的**，不是声称的：留出集 11/12 首选、12/12 入选；细节与未命中项见 `docs/verification.md`。

---

## 7. 卸载

```
plugin_manager remove_bundle → dsh-plugin-skill-autoroute
```

或从 profile `package.json` 的 `dependencies` / `dsh.profile.bundles` 移除后 `pnpm install`，并删掉 patch 层里的 `- insert:` 行。
