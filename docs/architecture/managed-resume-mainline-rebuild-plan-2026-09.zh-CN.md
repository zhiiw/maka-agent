<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Managed Resume 主线重建执行方案

状态：讨论稿；不是已实施合同，也不是发布就绪声明。

实施检查点：已从 `upstream/main@672d82731` 建立重建分支。核对现有 provider 生命周期后，暂不单独交付 A；将必要 bridge 与真实消费者一起实现。纯转换已迁移，完整进展和测试见 [提取账本](managed-files-rebuild-extraction-ledger.zh-CN.md)。下文未标明完成的步骤仍是计划。

2026-09-17 产品决定已确认：关闭旧上游 #4265，保留代码与历史作为提取来源；首版使用显式 managed 文件任务入口，放在 Desktop 加号菜单，与 Plan、Swarm 同级。不得因此默认切换普通聊天或既有任务的 durable mode。具体标签、菜单实现及权限可用性需按最新 Desktop 结构接线。

编写日期：2026-09-17。

## 1. 这次要交付什么

在最新主线的 Runtime、transcript 和 Host 生命周期上，让实际用户创建一个受管理的文件任务，在同一 accepted tree 上 Read/Glob/Grep/Write/Edit；进程中断后根据持久事实判断修改是否被接受，不重复已完成的文件副作用，不把恢复失败静默降级成普通 checkout 写入。

首个闭环不要求 Bash、npm、测试命令、自动发布到用户 checkout、Undo、Rebaseline 或 GC 产品化。它们不是验证文件修改恢复的前置条件。

“恢复一次修改”和“自动继续整个任务”分开验收：前者完成并不意味着后者已实现。

## 2. 已核实的基线与变化

本次核查快照：

| 对象 | 版本/状态 | 对重建的意义 |
| --- | --- | --- |
| `apache/maka` main | `846f4fbaa` | 后续实施开始时重新 fetch，不永久锁死这个基线 |
| 上游 PR #4265 | `70053087a`，Draft | 相对上述 main，551 behind / 7 ahead |
| PR #5287 | `4a42aaeab`，已合并 | 主动删除未接线的 managed Runtime 路径及专用测试，保留 Storage 格式和恢复支持 |
| PR #5366 | 包含在上述 main | transcript 已继续演进，旧分页/overlay 实现不能覆盖回来 |
| 旧 #4265 CI 修复 | `70053087a` | 删除无跨包消费者的 package export；本地合同测试 3/3，通过不代表新基线 CI 已通过 |

已尝试普通 rebase，在第一个测试提交出现冲突后核查到上述主动删除；已中止并恢复干净工作树，远程没有被改写。

主线现有 `prepareExecution` 是 client-capability preparation，不是 managed workspace settlement API。不能为了复用代码，把 managed Write/Edit 假装成 client capability，继承错误的权限条件。

主线 Execution Stores 已统一跟踪在途操作、检查 lease、关闭入口并 drain。旧 bridge 直接持有底层 store 的调用方式必须重新适配，不能绕过这些约束。

## 3. 约束与非目标

1. 新主线是实现基座，旧 stack 是设计、算法和测试素材，不是待整体合并的分支。
2. 保留主线已有 transcript 单权威、model projection、工具权限和 commit-before-publish 行为。
3. durable mode 在 T1 前固定；T1 后绝不根据字段缺失或异常切换 generic writer。
4. accepted truth 来自 SQLite 中 immutable RuntimeEvents；head/reservation 是其受约束投影。Git candidate 是内容证据，accepted ref 是可修复投影，不是另一套 acceptance truth。
5. 不承诺 pure transform 跨进程只运行一次。允许 T2 前从相同持久输入确定性重算；保证同一 operation 最多接受一个精确终态。
6. 不把“没有生产消费者”机械当作所有基础设施的合并禁令；但新 Runtime 执行分支必须随真实消费路径证明，避免再次交付随后被删除的死路径。
7. 已发布主线数据不能按实验数据随意清理或改写。未发布私有草稿接口允许简化，但先确认边界，不能据此改动已合并协议。
8. 本轮不额外推进多代自动恢复、全局扫描优化、M4/M5 大规模重建。若实际查询资源问题阻止首个消费者安全启用，应先测量并列为该消费者的门槛，不能无条件延期。

## 4. 建议交付：两个主要单元，非十个小 PR

### A. Storage mutation authority 收窄（#4265 的候选替代范围）

主要不变量：只有当前有效的、绑定同一 Execution Stores 和 storage root 的 owner 能结算所属 mutation；关闭或撤权后权限不可继续使用。

保留/重建：

- owner/store/root 绑定的 candidate 与 no-effect 证明消费；
- 通过当前 Execution Stores 操作包装器执行读取与结算；
- close 开始后拒绝新操作，已进入的事务跟随现有 drain 协议结束；
- exact retry 与 cross-store 拒绝测试；
- 主线既有 reservation 与原子终态 writer，不平行再建一套。

不提前加入：

- 未被消费者使用的公开 package export；
- 单纯为旧 API 适配增加的层；
- 自动 re-home 数据库或新 schema migration；
- Runtime managed 分支、产品 profile 或 helper 打包。

特别审查旧 `adoptWorkspaceStorageRoot`：不能只因几张投影表为空就认为数据库没有既有 workspace 事实；投影可被删除重建。先核对主线 root binding 和 canonical ledger 的事实路径，再决定是否确需 adoption。不能直接照搬旧实现。

原子边界：继续使用现有 SQLite terminal/successor transaction；进程内能力不能代替数据库对 operation、root、base 和 reservation 的验证。

失败：跨 owner/store/root、已关闭 lease、证明不匹配均拒绝，原 reservation 不被错误释放。close/drain 失败遵循主线已有失败 owner 策略。

回滚：默认不改 schema；撤回新接线不删除已有事件。已持久化的 managed 状态仍由主线兼容读取，不能因此回退到普通工具写入。

独立交付条件：必须证明这一改动对现有 owner 边界有独立价值。如果核查发现只是给 B 准备的新工厂/包装，则并入 B，不为维持“两个 PR”硬造 A。

### B. 真实 managed 文件任务 + Write/Edit 接受与恢复

主要不变量：用户实际进入的 managed 文件任务中，一次 Write/Edit 的结果、accepted tree 与 durable terminal 一致；崩溃后不重复已接受的修改。

最小消费链：

```text
Desktop 明确的 managed 文件任务入口（推荐首版）
  → Host 验证 helper/profile 和 source admission
  → accepted baseline + session binding
  → accepted-world Read / Glob / Grep
  → T1 前冻结 mode/base/path/args/profile
  → Runtime-owned pure Write/Edit transform
  → Gitoxide immutable candidate
  → SQLite 原子 T2/successor/head/reservation settlement
  → adopted durable result 经主线统一路径发布
  → accepted-ref 幂等修复
```

将旧 #43 的 candidate/recovery、旧 #41 的必要 session/helper 组合以及最小 Desktop 消费入口按实际依赖提取。不是把三个旧 PR 的全部 diff 拼起来。

模型不能 Read 用户 checkout、却 Edit accepted tree。真实工具集最小闭环包含 accepted-world Read/Glob/Grep；不能用一个只写不读的 profile 冒充可用 coding task。

Git source 与非 Git source 使用不同 importer、相同 accepted-world 模型；不重新引入第三套 per-file checkpoint。推荐先以 Git source 完成真实纵向测试，再移植非 Git importer，并在宣称两种 source 都可用前补齐矩阵。

由于涉及 Runtime、Host、平台 I/O 和产品接线，B 默认 Draft。内部可分可审查提交，但不为每个接口另开一个 PR。是否仍需独立 release 改动，取决于当前 main 是否已提供可消费的 helper；不得预先假设旧打包代码仍适用。

## 5. Runtime 与 Host 的职责

| Owner | 拥有 | 不得拥有 |
| --- | --- | --- |
| Runtime | 已验证参数、调用生命周期、一次有界 immutable result、model projection、精确 response envelope | 靠 owner 返回的新 result 替换执行结果 |
| Host workspace owner | source/accepted identity、执行 profile、candidate/terminal 协调 | 改写 Write 的 content 或 Edit 的替换参数 |
| Gitoxide owner | immutable base 读取、candidate 内容与 receipt 校验、ref 操作 | 自行决定 SQLite accepted head |
| Execution Stores / SQLite | lease/drain、durable reservation、原子接受与 exact retry | 信任裸 OID 或任意 caller 声明的 no-effect |
| Desktop | 任务入口、状态和错误展示 | 自行判定是否可重跑工具或改写 durable 事实 |

实施时优先扩展当前统一工具执行/发布 owner，而不是恢复两个平行的 ToolRuntime。具体接口名和 union 形状待当前调用链原型验证，不在讨论稿中冻结公共 API。

## 6. T1 与 terminal 状态表

| 状态 | 允许行为 | 禁止行为 |
| --- | --- | --- |
| T1 前拒绝/取消 | 普通拒绝结果；无 reservation | 先持久化 managed T1 再做无 proof 的可失败 preflight |
| T1 后，纯操作明确无副作用失败 | Runtime error proof + owner 校验后原子终态 | 抛异常后直接遗忘 reservation；猜测无副作用 |
| 成功但内容未变 | no-change 成功终态，不推进 head | 把成功 no-op 当失败，或伪造 successor |
| candidate 已生成，T2 未确认 | 重验 exact receipt/输入，确定性收敛或 park | fallback 到 live checkout 重跑 |
| T2/successor 已提交 | 采用原 durable outcome，修复 accepted ref | 重新执行 transform 来重解释已接受结果 |
| 证明缺失/损坏/不匹配 | unsettled/park，保留证据 | generic T2、自动释放 reservation |
| T2 后 UI/telemetry 发布失败 | 保持原终态，修复展示或停止本轮 | 写入相反的失败 outcome、诱发重复修改 |

取消、异常和 disposal 都必须进入同一生命周期。保留 callback 不得在 owner 返回 terminal 后执行；在途调用必须被 join。严格 JSON snapshot 在遍历复制期间执行资源预算，不能先无界 clone 再检查。

## 7. 逐步执行清单

### 第 0 步：固定素材，不改变现有远程栈

1. fetch upstream/main 和相关 fork refs，记录精确 OID。
2. 保留 #4265 `70053087a` 和后续 stack 的备份引用。
3. 从最新 main 建专用重建 worktree；不触碰根工作区的用户改动。
4. 建 extraction ledger：每项记录来源 commit/file/test、当前 main 对应机制、保留/重写/丢弃、目的单元、验证状态。
5. 将跨分支 tip diff 仅作为线索：旧分支更新不同步会夹带 main 的 UI/Host 改动，不能把它当功能增量直接导入。

完成标准：能说明每一块为何进入新 diff，没有不明主线回退。

### 第 1 步：验证 A 是否值得独立存在

1. 跟踪当前 Execution Stores provider、lease、active-operation 和 close 的真实路径。
2. 先运行现有绿色测试，再加入跨 owner/store 和关闭后消费的最小反例。
3. 用最少的权限收窄让测试通过；不创建平行生命周期。
4. 检查 SQLite online/rebuild/exact-retry 保持一致。
5. 如果只剩未来工厂代码，停止独立 A，移入 B。

完成标准：有可复现的边界问题和修复证据；不是仅把旧文件编译通过。

### 第 2 步：B 的最小纵向实现

1. 使用真实 accepted base，先打通一次 Write：参数 → 纯转换 → candidate → SQLite terminal → live result。
2. 复用同一 owner 接入 Edit；验证不唯一匹配、目标缺失、no-op、取消。
3. 接入 accepted Read/Glob/Grep，证明读写同一个代码版本。
4. 全部通过主线 modelProjection/commit-and-publish 路径，不自行写 StoredMessage。
5. 接入当前 Host composition，验证能力缺失时在 T1 前拒绝。

完成标准：真实 Host/Runtime/helper 路径能执行成功与业务失败；不是 fake callback 手写 T2。

### 第 3 步：先证明恢复，再接 Desktop

1. child process 在 T1 后、candidate 发布后、SQLite commit 后、accepted-ref 更新前后退出。
2. 新进程读取同一 durable 数据并 reconcile，不能复用原进程 capability。
3. 验证唯一 terminal/successor、reservation 状态、结果一致、source checkout 字节未改变。
4. 验证 candidate/ref 损坏、权限失败、取消与锁竞争的 fail-closed 行为。
5. 将测试纳入实际 CI inventory；测试存在但没被 runner 调度不算证据。

完成标准：先有真实进程恢复证据，再开放 UI。可确定的 failpoint 之外还要说明 helper 子进程中断的覆盖边界，不把两次成功 failpoint 当作任意崩溃证明。

### 第 4 步：Desktop 最小产品验收

1. 已确认提供显式 managed 文件任务入口，放在加号菜单，与 Plan、Swarm 同级，保留现有普通聊天行为。该选择必须在任务创建和 T1 前确定，不能给执行中的普通任务静默切换模式。
2. helper/profile 不可用时明确说明并阻止 managed 任务创建，不让整个普通聊天不可用。
3. 创建后绑定 accepted workspace；任务中禁止静默切换普通 Write/Edit。
4. 展示内容在内部 accepted workspace，尚未自动修改用户 checkout。
5. 在真实 Electron 中创建任务、读取、修改、杀 Host、重启、检查 transcript 与 accepted 内容。

完成标准：不是只有 API/profile 字符串和单元测试。无需真实付费模型，可使用确定性 backend，但 Host/helper/SQLite/Desktop 都是真实组件。

### 第 5 步：提交与后续栈重建

1. 对每个交付重新核查最新 main 的重叠变更；不把机械“零 behind”当正确性证据。
2. 未改变的提交用 range-diff 核对；语义重写项用 ledger + 路径 diff + 原不变量测试说明，不声称 one-to-one 保留。
3. 通过后更新 #4265 的范围/标题/body 或提出替代 PR；选择应在确认 A 的实际范围之后作出。
4. 远程旧 stack 不批量强推。一个基座稳定后，再更新其直接依赖，并用精确旧 head 的 force-with-lease 防覆盖他人改动。
5. M3 continuation 基于新 owner 重接；M4/M5 继续作为素材，按用户价值逐项提取。

## 8. 测试与平台矩阵

以下是验收目标，不代表本轮已执行。

| 验证 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Storage capability / close / cross-root | 必跑 | 必跑 | 必跑 |
| SQLite terminal/crash/concurrency | 必跑 | 必跑 | 必跑 |
| 真实 Gitoxide candidate/reopen | 必跑 | 必跑 | 必跑 |
| Host + Runtime Write/Edit kill/restart | 必跑 | 必跑 | 不允许沿用旧 skip 后声称完整支持 |
| 实际 Electron 创建/重启/结果一致 | 平台发布前验证 | 用户本机及可用 CI 验证 | 用户本机及可用 CI 验证 |
| 断电/硬件缓存持久性 | 不由进程 kill 测试推出 | 不承诺普通 fsync 等价 full sync | 不由进程 kill 测试推出 |

若某平台尚不能证明完整 managed profile，该平台入口必须诚实禁用该能力，普通聊天不受影响；不静默使用弱保证模式。

最小反例集：

- 跨 owner/store/root 使用同一个 opaque 证明；close 与 commit 交错；
- owner 试图替换非路径参数或 live result；保留 callback、结果对象引用；
- 成功 no-op、真实 Edit 失败、T1 后取消；
- 先提交 T2 后发布失败；重试历史 successor 时 head 已前进；
- source 在任务期间改变，不能被错误吸收到 accepted 内容；
- Git/非 Git source 的确定性导入与 kill/reopen（两者宣称可用前分别验证）；
- capability 不足、错误 profile、恢复证据损坏时不跨 durable mode fallback。

## 9. 旧 PR 素材映射

下表 #40 等均指 `zhiiw/maka-agent`，不是 `apache/maka`。

| 来源 | 提取内容 | 不照搬内容 |
| --- | --- | --- |
| #40 / 上游 #4265 | 参数权限、纯转换、Storage proof tests | 被 #5287 删除的整套旧 Runtime 分支 |
| #43 | exact candidate reopen、accepted-ref 修复、恢复测试 | 旧 Host 接线及夹带的其他 main 变更 |
| #41 | session owner、必要 helper admission/release | 旧 Host 启动和手写 profile 协商 |
| #44 | accepted Read/Glob/Grep | 与新工具结果投影不一致的返回包装 |
| #45 | Git/非 Git source importer | 将模式决策散落多个 UI/Host caller |
| #46 | Desktop 任务入口 | 默认自动启用策略未经重新确认直接移植 |
| #42 | workspace-bound continuation | 旧 transcript/read-model authority |
| #47 | 以后评估自动恢复体验 | 本轮扩展多代自动 resume |
| #48–#89 | 以后逐项提取 M4/M5 | 整个历史 stack rebase 后直接作为最终交付 |

详细 file/test/commit ledger 在第 0 步建立；本表不是已完成提取清单。

## 10. 回滚与发布风险

- A 尽量只有进程内 API 收窄，不创建新持久化版本；是否可做到须由代码确认。
- B 如果必须新增 session/profile 持久字段，显式列出版本、旧 reader 行为与失败提示，不隐含承诺 downgrade。
- 禁用新任务入口，不等于已有 managed 任务可以当普通任务运行；已有任务仍须可读取，未结算操作只能保留/park 或由兼容 owner 恢复。
- 不删除 candidate/accepted history 来“清理失败”；证据保留和 M4 GC 是不同交付。
- 不用重试掩盖未知提交状态；先读取 immutable acceptance evidence。

## 11. 工作量组织与讨论项

以每个检查点的可演示结果推进，不预先承诺天数或全栈完成时间。最大不确定项是新 Runtime settlement 与 Host/provider lifecycle 的组合，不是纯转换算法。

本轮已确认：

**首版采用显式 managed 文件任务入口，而不是立刻替换所有普通 workspace task。入口放在加号菜单，与 Plan、Swarm 同级。**

推荐显式入口：先以最小真实产品闭环验证恢复，保留普通聊天可用性；Git/非 Git importer 自动选择与未来无感 resume 方向不变。代价是首版仍有模式感知。自动默认方案减少选择成本，但必须同时解决不支持 source、缺失 helper、已有 session 与能力协商的产品策略，扩大本轮范围。

后续再讨论，不在这一轮一次性拍板：

- A 是否有独立价值（先用代码事实判断）；
- 非 Git source 是否与 Git 首版同时开放（推荐同模型、顺序验证）；
- #4265 关闭并保留历史；重建完成后另行提交新交付，不删除原分支。

### Windows 专项验收

历史用户报告（2026-08-31）为 `sessions:create` 返回 `Managed coding is unavailable in the active Runtime Host.`：Host 状态 ready，但未提供所需 managed capability，任务没有成功创建。这不是已经证明的“已提交 Write/Edit 无法恢复”。另有旧 Windows 完整 Host/worker crash 用例跳过，以及 SQLite fixture 关闭顺序导致 EBUSY 的独立问题；不得混为一个根因。

新入口实现前先在 Windows 核对 helper 发布/加载、Host 实际 capability、启动先后顺序和 session 创建 admission。不可用时只禁用/解释 managed 入口，不能阻止普通聊天。随后用真实 Desktop 与 Host kill/restart 验证恢复；不得以 WSL 测试替代 Windows 原生证据，也不得沿用旧 skip 宣称 Windows 已支持。

旧 M5 stack 的 `runtime-managed-profile-negotiation-v1.zh-CN.md` 与 `managed-shell-external-effect-fencing-v1.zh-CN.md` 明确把完整 `managed-coding-v2` 绑定到 command sandbox，并在 Windows 广告空 profile 集合。新文件任务应将 Read/Glob/Grep/纯 Write/Edit 与 Bash/Node/npm 能力解耦：不因命令沙箱尚未就绪就禁用已独立证明的文件能力；也不能因此宣称 Windows 文件恢复已验证通过。

讨论阶段只产出本文。后续实施状态以提取账本为准；不得将计划中的平台和产品验收项视为已通过。
