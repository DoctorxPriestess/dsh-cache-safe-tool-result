# dsh-cache-safe-tool-result
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/doctorxpriestess/dsh-cache-safe-tool-result)

一个 DeepSeek Harness (DSH) 插件：让工具结果（tool result）保持**缓存前缀安全**。

DSH 的隐式 prompt 缓存是**前缀缓存**：只有当请求开头的 token 与之前完全逐字节一致时，provider 才会复用缓存前缀。DSH 内置的 tool-result pruner 会**原地**截断超长工具结果——它会为一个**已经被发送过**的结果追加一个替换节点，这会让该节点之后的所有内容失效，把整段尾部按未命中（uncached）重新计费。

本插件用两半堵住这个漏洞：

| 部分 | 作用 | 位置 |
| --- | --- | --- |
| **FIRST-PASS** | 在循环把工具结果写入 session surface **之前**截断它，走 DSH 官方扩展点 `tools/post-execute` waterfall | `src/index.js` |
| **GUARD** | 提供 `toolResultPruner` 服务（`dsh-compaction-basic` 消费的那个），并拒绝重写任何**已被 provider 请求送达**的结果 | `src/guarded-pruner.js` |

两半由同一行插件装载：`src/both.js`。

本插件所依据的两个真实会话的实测数据：缓存读取 330,502,592 token、未命中 4,394,655 token，热窗口内命中率 **99.7%**；而这些日志中所有大幅未命中跳变，恰好都发生在内置 pruner 重写已送达结果的时间窗（+299,372、+311,788、+95,353、+50,351 未命中 token）。

---

## A. 架构

```
                       ┌──────────────── profile（宿主面）────────────────┐
dsh-agent-loop         │                                                  │
  runGroup.commitReady │                                                  │
    └─ tools.finalize  │                                                  │
         └─ postExecute│  ctx.waterfall(agent scope, "tools/post-execute",  │
              │        │                 exec, result, next)              │
              │        │      ▲                                          │
              │        │      │  FIRST-PASS 监听器（src/index.js）        │
              │        │      └── { kind: 'accept', content: 截断后内容 }  │
              │        └───────────────────────────────────────────────── │
              ▼
        appendToolResult(session, …)   ← 结果只在此刻进入 surface 一次
              │
              ▼
     ┌── agent scope / preset "compaction" isolate 组 ────────────────────┐
     │  dsh-compaction-basic ── ctx.get("toolResultPruner") ──┐           │
     │                                                        ▼           │
     │  GUARD：本插件的受护 pruner（src/guarded-pruner.js）                │
     │      · 已送达  → 跳过，逐字节不变，不追加替换节点                    │
     │      · 未送达  → 截断（与内置实现同几何）                           │
     │      · 无法判定 → 跳过（fail closed）                              │
     └────────────────────────────────────────────────────────────────────┘
```

整个设计服务的不变量：

> **工具结果可以在它首次进入 session surface 之前被压缩；
> 一旦某个 provider 请求携带过它，它的字节就再也不会改变。**

## B. Hooks 与拦截点

这里用到的全部是公开的 DSH / Cordis 扩展点，没有改动任何 `node_modules` 文件。

| # | 扩展点 | 类型 | 用途 |
| --- | --- | --- | --- |
| 1 | `tools/post-execute` | agent scope 上的 Cordis waterfall | FIRST-PASS：替换即将被写入的内容 |
| 2 | `toolResultPruner` | **profile composition 顶层**的 Cordis service | GUARD：成为 `dsh-compaction-basic` 解析到的 provider |
| 3 | `cordis.patch.yml`（profile 自己的用户层） | 官方文档化的 patch layer | 装载 #2 的行替换（由 `tools/install-preset.mjs` 完成） |
| 4 | `session.snapshotEvents(seq+1)` | session log API | 证明某节点是否已被送达 |

### provider 行到底在哪里

`dsh --dump-config` 能直接给出答案，在任何 DSH 版本上接线前都值得先看一眼：

```
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

它由 `@deepseek-ai/dsh-base` 贡献在 **profile composition 的顶层**，外面没有
`isolate` 包裹；`dsh-compaction-basic` 是它的同级行，用
`this.ctx.get("toolResultPruner")` 读取它。由此有两点结论：

* profile 自己的 `cordis.patch.yml` 就是正确的缝——它是官方文档化的用户层，在所有
  bundle 层之后应用，因此既不需要改 preset，也不需要改 `node_modules`；
* 按 id 定位的 patch **不能改行名**：它的 `name` 是"名字不符就跳过"的校验，
  不是覆盖（`applyEntryPatches` 会跳过并告警）。所以替换只能是官方的那一对操作
  ——把内置行 `disabled: true`，再 insert 本插件的行。

### 为什么 GUARD 是"替换"而不是"包装"

* 内置 pruner 是一个 Cordis **service**，它自身没有暴露任何 event / waterfall /
  registry / hook 缝，因此没有东西可以监听；
* Cordis 按 **scope label** 解析 service，在自身 label 没有实现的 scope 里调用
  `ctx.get(name)` 会返回 `undefined`——这一点已在 `test/integration/cordis.test.js`
  中用真实运行时验证（"an isolated scope hides the service from its parent"），
  这也正是 agent preset 无法跨越 `isolate` 边界拿到宿主面实例的原因；
* 在已有该 service 的作用域内调用 `ctx.provide("toolResultPruner", …)` 会抛出重复
  注册错误。

因此，在不打补丁的前提下，唯一受支持的做法就是在同一个作用域里**成为**
`toolResultPruner`，而这正是"disable + insert"这对 patch 所做的。
`dsh-compaction-basic` 视该 service 为可选
（`const prune = this.ctx.get("toolResultPruner")`），所以这个替换不需要改动别处。
`src/both.js` 因此实现了内置 service 暴露的同名两个方法——`pruneContent(blocks)`
与 `pruneSession(session)`——算法是 `src/truncate.js` 中约 50 行的上游镜像实现。

FIRST-PASS 一半没有这个约束，是纯增量的。它和 GUARD 共用一行只是工程上的便利
（一次编辑而不是两次），并非必须同作用域：普通插件注册的监听器是 untagged 的，
而 `dsh-scope` 的派发过滤器会把 untagged 监听器放行到所有 scope，所以
`tools/post-execute` 监听器无论该行挂在哪里，都会收到 agent 的事件。

## C. FIRST-PASS：为什么不存在竞态

```
runGroup.commitReady()
  → tools.finalize(exec, result)
      → postExecute(exec, result)          ← 本插件监听器在此运行
          → ctx.waterfall(…, exec, result, next)
      → 返回 accept 后的结果（content 已截断）
  → appendToolResult(session, result)      ← 结果在此进入历史
```

监听器严格在 **append 之前** 运行，并且遵守 DSH 的 decision 协议而非绕过它：

* 先 `await next()`，因此更早的监听器与内置行为优先；
* `block` decision 原样返回；
* 已经替换了 `value` 的 `accept` decision 原样返回——`value` 分支只对成功结果有效，
  此时同时改写 content 会让两者失配；
* 本行内任何异常都返回内层 decision，因此本插件永远不会把一次工具调用变成失败。

这里没有可输的竞态，因为不存在第二个写入者：surface 节点只被创建一次，用的就是
（已经截断的）结果。

## D. 如何判定"已送达"

DSH 在任何地方都没有记录 `sentToProvider` / `lastSentSeq` / `requestWatermark` /
`deliveredSeq`（对已安装 harness 全量 grep 无命中）。日志中唯一可证明"请求已被准入"
的证据是后续的结算事件，因此 GUARD 使用：

```
delivered(node)  ⟺  session.snapshotEvents(node.seq + 1) 中存在事件
                    type ∈ { "assistant/message", "assistant/attempt" }
```

* `assistant/message` 结算一次 provider 已回答的请求；
* `assistant/attempt` 结算一次已流式发出但最终失败的请求。它无法证明 provider 收到了
  载荷，因此仍按"已送达"处理——GUARD 宁可少剪一点历史，也不冒险改写它；
* 该谓词是**单调**的：随着日志增长只会由假变真，因此已送达节点在重试、恢复、重复
  修剪中始终保持"已送达"；
* 如果 session 没有暴露 `snapshotEvents`，GUARD **抛出并跳过该节点**：不可判定的状态
  永远不会被当成"可以安全重写"。

这是刻意单边的：误判为"已送达"只损失一点修剪容量；误判为"未送达"则意味着整段缓存前缀
失效。FIRST-PASS 一半正是用来补回这个保守选择让出的容量。

## E. 为什么已发送的历史不会被重写

三个相互独立的机制，按重要性排序：

1. **对已送达节点，GUARD 根本不会调用 `append`。** 不是回滚、不是复制后替换、不是
   事后修正：节点在任何变更尝试之前就被跳过（`pruneSession` 先构造候选列表，之后只
   重写可证明未送达的候选）。
2. **也不会回滚内置 pruner 已经做过的事。** 如果某个已送达节点过去已被内置 pruner
   替换过，本插件不会尝试恢复它——那会是对同一前缀位置的第二次改写，会再次破坏缓存。
   替换历史（`surface.replaceGeneration`）只被读取，从不被改动。
3. **替换事件是追加的，不是就地修改的。** 即使 GUARD 确实进行了修剪，它也用与内置
   service 相同的形状（先 `compaction/prune` 影子计价事件，再一个带
   `surfaceOp: { op: 'replace' }` 的 `tool/result`），因此回放看到的是普通的
   追加式日志。

`test/regression/real-session.test.js` 会把两个真实会话的 surface 回放给 GUARD，并断言
**全部 15 个被记录的替换目标（8 + 7）都被拒绝**，且在连续三次 pass 之后每个目标的
内容哈希都不变。

## F. 测试

```
node --test "test/**/*.test.js"      # 68 个测试
```

| 套件 | 固定住什么 |
| --- | --- |
| `test/unit/truncate.test.js` | 与内置 pruner 的几何一致性、code point 边界、不切开代理对、marker 只出现一次 |
| `test/unit/guarded-pruner.test.js` | 16 个用例：已送达 → 跳过且逐字节一致；未送达 → 照常修剪；`assistant/attempt` 计入；UNKNOWN 状态 fail closed；`snapshotEvents` 抛异常也不会崩；重复 pass；带偏移基准的（fork）日志；子 agent surface；append 被拒绝时不留半成品 |
| `test/unit/install-preset.test.js` | profile patch 编辑恰好新增那两个 entry、保留无关 entry、幂等、revert 后与之前的列表完全一致；块式与流式 YAML patch 文件都能解析；读不懂的内容宁可拒绝也不重写 |
| `test/integration/cordis.test.js` | 针对本地 DSH 安装中的**真实** Cordis 4.0.2：`provide` 可用、重复注册会响亮地抛错、isolate 作用域对父级隐藏该 service，且组合行能通过真实 `ctx.waterfall` 完成截断 |
| `test/regression/real-session.test.js` | 两个脱敏生产会话轨迹：记录的缓存跳变是真的；每个被记录的已送达重写都被拒绝；已送达历史在多次 pass 后字节稳定；同一 surface 上新追加的节点仍会被修剪 |

68 个全部通过（`node --test`，Node 24）。回归 fixture **不含任何消息内容**——只有
`seq` / 类型 / surface op / 工具名 / 字符数 / 内容哈希 / provider usage——且没有任何
测试会访问 provider。

## G. 真实验证

两个生产会话（`0dd710b3`、`75258c73`）在内置 pruner 生效的情况下被记录。可从 fixture
复现的关键事实：

| 会话 | 窗口 | 未命中输入 | 缓存读取 | Δ 未命中 |
| --- | --- | --- | --- | --- |
| `0dd710b3` | 840 → 856 | 1,417 → 300,789 | 348,544 → 18,432 | **+299,372** |
| `0dd710b3` | 2559 → 2573 | — | −100,480 | **+95,353** |
| `75258c73` | 2326 → 2338 | — | 348,288 → 35,200 | **+311,788** |

每一次跳变都紧跟在一批 `compaction/prune` + `tool/result(replace)` 事件之后，这些事件的
目标节点在被替换前已经存活了 75–299 个已完成请求。把这些 surface 回放给受护 pruner，
对这些目标产生**零**次替换。

### 真实 harness 上的端到端验证

安装路径与 FIRST-PASS 机制都在真实 DSH harness（`@deepseek-ai/dsh` 0.1.5-rc.2）上跑过
端到端验证，并且是在隔离的 `DSH_HOME` 里进行的，因此**没有动过你正在使用的 profile**：

1. 用 `dsh plugin --profile <p> add <本 checkout>` 安装到某个 profile；
2. 用 `node tools/install-preset.mjs --profile <p>` 接线；
3. 用 `dsh --profile <p> --dump-config` 确认组合结果；
4. 跑一个 headless 会话，让某个工具产出很大的结果。

在产生的 session 日志中观测到：

| | 基线（内置 pruner） | 启用本插件后 |
| --- | --- | --- |
| 准入时的 tool-result 字符数 | 50,000 | **5,159** |
| 首次准入中是否含 prune marker | 无 | **有（位于第 4,098 个 code point）** |
| `tool/result` 替换事件 | 0 | **0** |
| `compaction/prune` 事件 | 0 | **0** |

结果是以已截断的形态、且只进入 surface 一次，之后没有任何替换节点——这正是本插件的全部
主张。`tools/session-report.mjs` 可以从任意 session 日志复现这些数字。

### 结论的边界

这些检查证明的是**surface 变更被消除**、且真正生效的是替换行本身。它们不会访问
provider，因此没有观测到缓存命中；那需要真实会话（见"如何判断它在工作"）。

## H. DSH 安装未被修改

**没有任何 `@deepseek-ai/dsh*` 包下的文件被修改。** 用到的每个缝都是公开 API：

* `tools/post-execute`——一个供其他插件监听的 event；
* `toolResultPruner`——一个供其他插件提供的 Cordis service；
* `agent.cordis.yml`——用户自己拥有的 preset composition
  （`dsh-agent-presets` 的 `writableRoot`）。

本工作更早的阶段确实为了给机制做原型而修改过已安装的 pruner。该补丁已被完全还原，
已安装包与其原始状态逐字节一致；`src/` 中没有任何对它的引用。

## I. 文件

```
src/index.js             FIRST-PASS 行（tools/post-execute 监听器）
src/both.js              组合行：一次装载两半
src/guarded-pruner.js    GUARD：toolResultPruner service + 送达判定
src/truncate.js          上游镜像的 head/middle/tail 几何（两半共用）
tools/install-preset.mjs 幂等、可逆的 profile patch layer 安装
tools/session-report.mjs 读取 session 日志并汇报 prune/replace/marker 计数
tools/extract-session-trace.mjs  脱敏轨迹提取器（多帧 zstd）
cordis.patch.yml         bundle 标记；刻意是空 patch 列表（见文件内说明）
test/unit/*              几何、GUARD、安装器
test/integration/*       真实 Cordis 上下文与真实 waterfall
test/regression/*        两个脱敏生产会话轨迹
test/fixtures/*.trace.json  脱敏轨迹
```

## 安装

### 速览

```sh
# 1. 把插件装进某个 profile
dsh plugin --profile web add github:DoctorxPriestess/dsh-cache-safe-tool-result

# 2. 接线到 profile（这是真正起作用的一步）——在已安装的包目录里执行
cd "$DSH_HOME/profiles/web/node_modules/dsh-cache-safe-tool-result"
node tools/install-preset.mjs --profile web

# 3. 重启 dsh，然后确认它实际组合出的内容
dsh --profile web --dump-config
```

### 第 1 步：把插件装进某个 profile

`dsh plugin` 是一个很薄的 `pnpm` 转发器：首次使用时初始化 profile，在
`<DSH_HOME>/profiles/<name>` 里执行转发过去的 pnpm 参数，然后按"实际装上了什么"来
对账 `dsh.profile.bundles`。

```sh
# 常见情况：web profile
dsh plugin --profile web add github:DoctorxPriestess/dsh-cache-safe-tool-result

# 别的 profile
dsh plugin --profile tui add github:DoctorxPriestess/dsh-cache-safe-tool-result

# 从本地 checkout 安装（相对路径以"你当前所在目录"为基准，而不是 profile 目录）
dsh plugin --profile web add /path/to/dsh-cache-safe-tool-result

# 锁定版本
dsh plugin --profile web add github:DoctorxPriestess/dsh-cache-safe-tool-result#v1.0.0
```

包装为 profile 的一个依赖，并被追加进 `dsh.profile.bundles`
（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、…、
`dsh-cache-safe-tool-result`）。用下面这条确认：

```sh
dsh --profile web --dump-config
```

本包自带的 bundle patch 刻意是空列表，所以"只装包"不会改变任何行为——真正替换
provider 行的是第 2 步。

### 第 2 步：接线到 profile

```sh
# 安装器随包发布，直接在包目录里运行
cd "$DSH_HOME/profiles/web/node_modules/dsh-cache-safe-tool-result"

node tools/install-preset.mjs --list              # 有哪些 profile
node tools/install-preset.mjs --profile web --dry-run
node tools/install-preset.mjs --profile web
```

如果你用的是 checkout 而不是安装副本，命令完全一样——只是那一行会指向你 checkout 的路径：

```sh
node tools/install-preset.mjs --profile web
```

卸载就是反过来做这两步：

```sh
node tools/install-preset.mjs --profile web --revert
dsh plugin --profile web remove dsh-cache-safe-tool-result
```

为了方便，`--preset <name>` 被接受为 `--profile` 的同义词；但它操作的是 **profile**，
不是 agent preset——provider 行位于 profile 组合里（见上文"provider 行到底在哪里"）。

第 2 步会编辑 `<DSH_HOME>/profiles/web/cordis.patch.yml`，只追加两个 entry，
其他内容——包括你自己原本放在那里的 patch entry——一律不动：

```yaml
- id: tool-result-pruner
  disabled: true
- insert:
    - id: cache-safe-tool-result
      name: 'D:/path/to/dsh-cache-safe-tool-result/src/both.js'
      config: { firstPass: true, guardedPruner: true, thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

它会先把已有文件按 YAML 读取（块式或流式、含注释都可以），再以 JSON 写回
（JSON 是 loader 接受的 YAML 子集），并在改动前写一个带时间戳的 `.bak`。回退：

```sh
node tools/install-preset.mjs --profile web --revert
```

第 1 步与第 2 步之后都重启 `dsh`。可以用下面这条确认 harness 实际组合出的内容：

```sh
dsh --profile web --dump-config
```

此时 `tool-result-pruner` 应显示 `disabled: true`，并在其后出现
`cache-safe-tool-result` 行。

### 为什么这一行用绝对路径

profile bundle 层里的裸包名会从 harness 安装位置（或 profile 的 `node_modules`）解析；
本插件是通过 `dsh plugin add` 安装的，所以按包名也能解析到——但安装器选择用绝对路径指向
checkout，这样这一行永远指向你可读可改的那份代码，checkout 副本与已安装副本也不会悄悄
分叉。绝对路径受支持，内部会转成 file URL（含 Windows 盘符路径）。

> 如果希望它指向**已安装副本**（例如你后续用 `dsh plugin ... update` 升级），把
> `--entry` 指过去即可：
> `node tools/install-preset.mjs --profile web --entry "$DSH_HOME/profiles/web/node_modules/dsh-cache-safe-tool-result/src/both.js"`

## 配置

| key | 默认值 | 含义 |
| --- | --- | --- |
| `thresholdChars` | `8192` | 文本超过这么多 code point 时截断 |
| `headChars` | `4096` | 保留开头多少个 code point |
| `tailChars` | `1024` | 保留结尾多少个 code point |
| `firstPass` | `true` | 装载准入前截断监听器 |
| `guardedPruner` | `true` | 提供带送达保护的 `toolResultPruner` |
| `includeNested` | `true` | FIRST-PASS：也截断子派发结果 |
| `verbose` | `false` | 打印每次截断与每轮 pass 的细节 |

`thresholdChars`、`headChars`、`tailChars` 与内置 pruner 的默认值完全一致，因此这个替换
不会改变一个 session 保留多少上下文。配置会被校验：`headChars + marker + tailChars`
必须能塞进 `thresholdChars`，非整数或负值会在挂载时抛错，而不是悄悄做出错误行为。

## 如何判断它在工作

* **FIRST-PASS**：打开 `verbose: true` 后，一次截断会打印
  `truncated <tool> result <before> -> <after> code points before admission`。
* **GUARD**：仍在修剪的 session 里，不会再出现针对"早于最后一次请求的节点"的
  `tool/result` 事件带 `surfaceOp: { op: 'replace' }`。
* **缓存本身**：在真实会话中对比各轮的 `prompt_cache_hit_tokens`。对已送达历史的重写会
  表现为缓存读取大幅下降、未命中输入同步跳升；GUARD 的全部意义就是让这件事不再发生。

## 已知限制与升级风险

1. **几何是移植，不是 import。** 上游包的默认导出是一个在构造时自注册的 Cordis
   `Service`，所以为了拿它的 `pruneContent` / `PRUNE_MARKER` 导出而 import 并非无副作用。
   `src/truncate.js` 是 v0.1.5-rc.2 算法的逐字符移植，并有同几何测试。**若上游改了算法，
   只需要跟进这一个文件。**
2. **service 契约同样是移植。** `pruneSession` / `pruneContent` / `measureContent` /
   `config` 镜像内置 surface。若未来 DSH 版本新增了消费者会调用的方法，本 provider 也必须
   补上。集成测试固定住了今天存在的方法。
3. **`assistant/attempt` 被当作已送达。** 当请求在 provider 看到之前就失败时会损失一些
   容量；正确性不受影响。
4. **GUARD 只能保护它看得见的东西。** 由**其他**插件执行的重写（例如某种自己编辑历史的
   压缩策略）不在本插件控制范围内。
5. **安装按设计分两步。** 包安装与 profile patch 分开，是因为 bundle patch 层既不能改行名
   也看不到 preset 内部；行替换有脚本、可 dry-run、可回退，但不是零接触。
6. **不在范围内**：压缩阈值调优、`reasoning_content` 与工具调用参数压缩、provider 的缓存
   算法、system prompt / persona 调优。
7. **没有发布到 npm。** `package.json` 刻意保留 `"private": true`：它从源码或 GitHub 安装。

## 许可证

MIT —— 见 `LICENSE`。
