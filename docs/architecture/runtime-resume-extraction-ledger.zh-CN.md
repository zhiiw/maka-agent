# Runtime Resume #1346 Extraction Ledger

- 状态：Active
- 更新日期：2026-07-27
- 来源 PR：`maka-agent/maka-agent#1346`
- 来源 head：`24bb5f33`
- 来源 base：`0aabde97`
- 新切片基线：`upstream/main@ab9aa2b0`
- 规则：按不变量重写或移植，不按旧 commit 边界 cherry-pick

## 1. 为什么需要这份 ledger

#1346 包含 45 个 commit、76 个文件、约 13,000 行新增代码。它同时修改了 recovery fact
持久化、continuation、文件工具执行、provider replay、Desktop/CLI owner 和尚无生产消费者的原型。
这些能力不能在一次审批中共同证明。

本 ledger 是拆分工作的审计账本。每个旧 commit、生产文件和测试文件都必须有明确去向：

- `PR1`：Recovery persistence authority；
- `PR2`：Continuation correctness；
- `PR3`：本地文件 mutation 的因果证据与安全 finalize；
- `PR4`：CLI/Desktop owner 与资源生命周期；
- `DEFER`：未来独立 PR，当前不移植；
- `DROP`：实现型、重复或已被重写取代，不移植；
- `DOC`：只进入 roadmap/历史说明。

任何标记为 `PR1/PR2`、`PR2/PR4` 等的条目都必须按 hunk 拆分，禁止整体搬运。

## 2. 四个 PR 的唯一不变量

### PR 1 — Recovery persistence authority

> reserved recovery fact 只有一个原子写入权威；`completed` 必须引用同 execution identity
> 下已经持久化的 outcome；SQLite projection 可以只从 immutable RuntimeEvents 重建。

包含：

- 最小 recovery fact schema；
- 单一 atomic bundle writer；
- generic append/import/JSONL 的 reserved-fact 拒绝；
- execution identity、evidence order、completed→outcome 校验；
- projection rebuild；
- schema capability 与迁移；
- read model 对 recovery audit fact 的无消息行投影。

不包含 contract registry、reconciler、resume 接线、continuation 或文件实现。

### PR 2 — Continuation correctness

> continuation cursor 只引用 immutable RuntimeEvents；同一 source boundary 至多一个 durable
> claim；所有祖先 segment 使用同一 replay policy；复制/分支不能留下指向原会话的 recovery refs。

包含：

- immutable high-water 和 digest；
- ancestor segment 一致的 provider suffix trimming；
- durable continuation claim uniqueness；
- cancellation/terminal admission；
- conversation clone 的 ID map + typed ref rewrite，或显式拒绝；
- planning/execution 对同一 envelope 的 revalidation。

不包含 tool reconcile 或 workspace checkpoint。

### PR 3 — File mutation causal evidence and finalize-only recovery

> T1 选择 `reconcile` 时必须已有有效、workspace-bound 的文件证据；恢复只能在
> `current == expected-after` 时自动补 outcome；任何其他状态都 park，不能覆盖外部写入。

当前安全收缩：

- 正常 Write/Edit 仍通过原 filesystem worker 和现有权限/sandbox 边界执行；
- T1 前用与生产实现相同的 transform 生成 before/expected-after evidence；
- evidence 作为 canonical `toolDispatch` 的受校验字段与 T1 同事务提交，不新增独立
  recovery fact writer，也不允许 generic append 事后补造；
- checkpoint 绑定 trusted workspace、canonical target、operation identity 和 transform version；
- observer 有 workspace、regular-file、symlink、大小、编码边界；
- `current == expected-after`：cleanup/finalize 后原子提交 recovery bundle；
- `current == before`：持久化 `reconcile_not_applied`，planner/UI 输出
  `redo_disabled_pending_cas` 并 park；
- 其他：drift/conflict，park。

本 PR 不迁移旧的自动 redo、atomic rename replacement、Windows before backup、Git carrier 或
restricted verifier。原因是 atomic replace 不是 conditional replace，旧 checkpoint 的长窗口 redo
无法保护另一个进程在最终检查后写入的内容。

### PR 4 — Host owner and resource lifecycle

> 每个 host 对 SQLite、worker、recovery registry 和 background resume task 都有唯一 owner；
> 初始化失败、取消和退出时资源按相反顺序、恰好一次释放。

包含：

- CLI interactive owner；
- Desktop app lifecycle 的启动/关闭责任；
- background resume promise 的错误收敛；
- store/worker 初始化失败清理；
- 同 workspace 多 host 的显式拒绝或受控策略。

PR4 不改变 recovery 判定语义，不阻塞 PR1–3 替代 #1346。

## 3. PR A 重写的影响评估

当前 `codex/runtime-recovery-authority` 是 PR1 的重写，基于
`upstream/main@ab9aa2b0`，包含：

- `34805553 feat(core): define recovery fact bundle authority`
- `68ee74de feat(storage): make recovery bundle writes authoritative`
- `f464cfb1 feat(runtime): enforce recovery fact causality`

影响判断：**中等、可控，不需要推翻。**

### 已经优于旧实现的部分

- 没有复制 #1346 的 split fact writer；
- 没有通用 `runtimeFact` 作为第二条公共扩展写入口；
- SQLite、JSONL、batch import、terminal durability 都不能绕过 bundle writer；
- commit、rebuild、resolver 共用一个 pure bundle validator；
- completed、parked 的精确重试均幂等；
- corruption 单调且物理 `event_seq` 顺序参与校验；
- PR1 没有带入 contract registry、file checkpoint、Desktop/CLI 接线。

### 不能机械迁移的旧测试

旧 `tool-recovery-fact-writer.test.ts` 锁定了已删除的 split writer，整体 `DROP`。其中有价值的原子性、
identity drift、completed-without-outcome 场景已经由 PR A 的 core/storage/resolver 测试重写。

旧 `recovery-resolver.test.ts` 和 `sqlite-runtime-store.test.ts` 只能逐 case 对账：

- 新测试提供等价或更强证明：`superseded-by-rewrite`；
- 仍是黑盒行为且 PR A 缺失：先移植测试，再补最小代码；
- 依赖旧 `runtimeFact`/journal 内部形状：`DROP`；
- 属于 PR2/PR3：留给对应分支。

因此 PR A 的测试处理不是“把旧测试迁进来”，而是建立场景对账：

| 旧测试锁定的内容 | PR A 处理 |
|---|---|
| split fact writer 的公开 API 与内部调用顺序 | `DROP`；该入口本身违反单一 authority |
| recovery fact 解码、execution identity、evidence order | 由 core bundle validator 测试重写 |
| reconcile/outcome/decision 原子提交与 failpoint rollback | 由 SQLite bundle 黑盒测试重写 |
| exact retry、identity drift、completed-without-outcome | 由 store + resolver 组合测试重写 |
| projection rebuild 与同毫秒事实排序 | 由 immutable RuntimeEvent `event_seq` 测试重写 |
| contract registry、file checkpoint、continuation | 不属于 PR A，分别留给 PR3/PR2 |

只有“旧场景仍属于 PR1，且新测试无法提供同等或更强证明”时，才先在 PR A 上补一个
production-shaped RED test。迁移旧 helper、旧 fixture 或旧 API 不是验收目标。

### PR A 当前测试审计状态

已经覆盖：

- core bundle decode/identity/evidence/completed-with-outcome；
- generic append、batch import、terminal durability 与 JSONL 绕过被拒绝；
- reconcile + outcome + decision 单事务提交；
- `after_recovery_outcome` failpoint 的全事务回滚；
- exact completed/parked retry；
- projection rebuild、同毫秒事实按 physical `event_seq` 重放；
- schema 4 populated database 升级与 capability fail-closed；
- resolver 对 completed-without-outcome 与 corruption sticky 的拒绝。

PR A 发布前仍需补两条，不从旧测试文件机械迁移：

1. `after_recovery_reconcile` failpoint：证明仅写入 reconcile 后崩溃时，fact、journal 和
   operation projection 全部回滚；
2. public bundle API 提交成功 → close → reopen → 删除/重建 projection → resolver 仍从
   immutable RuntimeEvents 得到同一 completed/parked 结论。

PR1 的 production-shaped 边界是公开 storage capability 与 RuntimeEvent consumer，不是
SessionManager、Desktop 或真实 Write/Edit。把后者塞进 PR A 会重新扩大不变量边界。

### Schema 5 碰撞

#1346 的未合并 schema 5 capability 是：

```text
runtime_fact_envelope@1
```

PR A 的 schema 5 capability 是：

```text
tool_recovery_bundle@1
```

两者不能互相解释。PR A 构造时校验 capability，因此旧 Draft/dogfood DB 会 fail closed，而不是被
静默误读。这是正确的安全行为，但不是数据迁移。

处理策略：

- `main` 的 schema 4 → PR1 schema 5：正式支持并有 populated migration test；
- #1346 schema 5/6 dogfood DB：不承诺就地兼容，测试时使用备份或新 profile；
- 合并前在 PR 描述明确说明该限制；
- 不为了兼容未合并 Draft schema 引入双协议 reader。

## 4. Commit extraction ledger

合并 commit 一律不 cherry-pick；跨不变量 commit 一律按 path/hunk 提取。

| Old commit | 归属 | 处理 |
|---|---|---|
| `2583af51` docs phase 3/4 | DOC | 只取仍成立的设计结论，roadmap 重写 |
| `6a31b2ad` forward-compatible facts | PR1/PR2 | PR1 fact/read-model 行为已重写；resume 部分留 PR2 |
| `34add649` gate fact writers | PR1/PR2 | PR1 writer gate 已重写；resume tests 留 PR2 |
| `64db384b` recovery contracts | PR3 | 只提取 contract 黑盒测试，不搬 resolver 实现 |
| `e1a65f9e` rejection codes | PR3 | 在 PR3 定义最小稳定 code |
| `4b56c275` share contracts | PR3 | planning/execution 使用同 registry；按 hunk 提取 |
| `b018ad38` consume decisions | PR1/PR3 | PR1 只保留 causal validation；消费/规划留 PR3 |
| `609ae944` fact writer | DROP | split writer 被 PR1 单一 bundle writer 取代 |
| `8a9f2de9` durable fact projection | PR1 | 由 PR1 bundle/rebuild 重写 |
| `32944ac2` interrupted file tools | PR3/DEFER | contract/coordinator tests 重写；restricted verifier defer |
| `0447e9bb` atomic recovery facts | PR1 | 由 PR1 单 bundle transaction 重写 |
| `b973c72f` production wiring | PR3/PR4 | reconcile 接线属 PR3；owner 生命周期属 PR4 |
| `6b9e6145` production wiring docs | DOC | 按新 PR3 finalize-only 边界重写 |
| `72962092` recovery edge tests | PR3 | 逐 case 提取，先测试后代码 |
| `5c4abaf5` provider tails | PR2 | 归入统一 replay suffix policy |
| `45e04fdb` test import fix | DROP | 无独立行为，不迁移 |
| `56aa9078` edit without checkpoint | PR3 | 保留 fail-closed 场景，改用新 reason |
| `9724ceef` prepared checkpoint | PR3/DEFER | evidence schema 属 PR3；Git carrier defer |
| `7e812035` prepare before dispatch | PR3 | 只取 T1 前 evidence invariant 与测试 |
| `c88b340d` prepared recovery | PR3 | 只取 after-finalize；redo path 不迁移 |
| `9cf4d8c0` host checkpoint wiring | PR3/PR4 | capability wiring 属 PR3；owner 属 PR4 |
| `d4faea85` native file checkpoint | PR3/DEFER | bounded evidence 属 PR3；Git prototype defer |
| `76d2aba9` local carrier host | PR3/PR4 | carrier registration 属 PR3；lifecycle 属 PR4 |
| `9d204a3e` checkpoint hardening | PR3 | 提取 bounds/symlink/identity tests，不搬 Git code |
| `43205d15` builtin recovery mode | PR3 | 生产形状测试与最小 builtin wiring |
| `15785db0` restart e2e | PR3 | 重写为 after-finalize crash/reopen test |
| `25d5c888` trim model suffix | PR2 | 统一 immediate + ancestor replay policy |
| `5c3e948a` recovery summaries | PR3 | 仅在有真实 UI/host consumer 时提取 |
| `1cda90cd` formatting | DROP | 不迁移 |
| `cdad0954` merge upstream | DROP | merge commit |
| `eceb89ad` schema expectation | PR1 | PR1 已按 schema 5 重写 |
| `986e626d` merge upstream | DROP | merge commit |
| `2647eaa8` merge workspace identity | DROP | merge commit |
| `82ad92ac` merge subagent relations | DROP | merge commit |
| `1eeb9f87` file boundary hardening | PR3/PR4 | worker ownership/metadata tests属 PR3；owner属 PR4 |
| `23d426c0` effect-aware recovery | PR3/PR4 | unsettled semantics属 PR3；resource cleanup属 PR4 |
| `db263cec` admission/recovery invariants | PR2/PR3/PR4 | 必须按 hunk 拆分，禁止整体搬运 |
| `3f620f79` merge upstream | DROP | merge commit |
| `1f1ae1f9` formatting | DROP | 不迁移 |
| `8bfc5ed3` CI warning allowlist | DROP | 不把临时 warning 固化为新契约 |
| `52b9ae9e` file recovery hardening | PR3 | 提取 workspace/symlink/bounds tests；redo 不迁移 |
| `29ae3a3b` merge upstream | DROP | merge commit |
| `dde9bb87` settlement API tests | PR3 | 按 main 当前 API 重写 |
| `65a6dffa` formatting | DROP | 不迁移 |
| `24bb5f33` target identity | PR3 | trusted workspace/canonical target 测试先行 |

## 5. 生产文件 extraction ledger

### Host 与文档

| 文件 | 归属 | 处理 |
|---|---|---|
| `apps/desktop/src/main/app-lifecycle.ts` | PR4 | 只提取 owner/startup/shutdown 责任 |
| `apps/desktop/src/main/main.ts` | PR3/PR4 | PR3 注册最小 capability；PR4 管生命周期 |
| `apps/desktop/src/main/tool-assembly.ts` | PR3/PR4 | registry/carrier factory 属 PR3；close owner 属 PR4 |
| `packages/cli/src/runtime-bootstrap.ts` | PR3/PR4 | 功能 wiring 与 interactive owner 分 hunk |
| `scripts/check-console.mjs` | DROP | 不迁移临时 warning 例外 |
| `docs/architecture/runtime-resume-phase1-safe-boundary-contract.md` | PR2/DOC | 只更新 admission/claim 契约 |
| `docs/architecture/runtime-resume-phase3-phase4-workspace-checkpoint-design.zh-CN.md` | DOC | 用最新实施路线重写 |
| `docs/runtime-resume-tool-journal-design-draft.zh-CN.md` | DOC | 保留历史，不再作为 roadmap |

### Core

| 文件 | 归属 | 处理 |
|---|---|---|
| `packages/core/src/runtime-event.ts` | PR1 | PR A 已重写最小 fact schema |
| `packages/core/src/runtime-event-store.ts` | PR1/PR2 | bundle capability 属 PR1；claim API 若需要属 PR2 |
| `packages/core/src/agent-run.ts` | PR2 | continuation/cancel/lineage identity |
| `packages/core/src/index.ts` | PR1/PR2/PR3 | 每个 PR 只导出自己拥有的 API |

### Runtime — PR1

| 文件 | 归属 | 处理 |
|---|---|---|
| `packages/runtime/src/recovery-resolver.ts` | PR1/PR3 | PR1 只做事实/腐败判定；contract 决策留 PR3 |
| `packages/runtime/src/runtime-event-read-model.ts` | PR1 | recovery audit facts 无聊天行 |
| `packages/runtime/src/tool-recovery-facts.ts` | DROP | 被 core 最小 fact + bundle validator 取代 |
| `packages/runtime/src/tool-recovery-fact-writer.ts` | DROP | 第二写入口，禁止迁移 |

### Runtime — PR2

| 文件 | 归属 | 处理 |
|---|---|---|
| `packages/runtime/src/continuation-admission.ts` | PR2 | 从测试重写 durable claim/admission |
| `packages/runtime/src/invocation-context.ts` | PR2 | 只提取 immutable replay identity |
| `packages/runtime/src/runtime-kernel.ts` | PR2/PR3 | replay/revalidation 与 recovery wiring 分 hunk |
| `packages/runtime/src/runtime-resume.ts` | PR2/PR3 | continuation materializer 与 tool recovery 分开 |
| `packages/runtime/src/runtime-runner.ts` | PR2 | envelope transport/revalidation |
| `packages/runtime/src/session-manager.ts` | PR2/PR3/PR4 | 三类 hunk 必须拆分 |
| `packages/runtime/src/run-trace.ts` | PR2/PR4 | continuation trace 与 lifecycle trace 分开 |

### Runtime — PR3

| 文件 | 归属 | 处理 |
|---|---|---|
| `packages/runtime/src/tool-recovery-contract.ts` | PR3 | 最小 registry 与 observe/finalize contract |
| `packages/runtime/src/tool-recovery-coordinator.ts` | PR3 | 串行 reconcile；只消费 PR1 bundle store |
| `packages/runtime/src/file-tool-recovery.ts` | PR3 | after-finalize / otherwise park |
| `packages/runtime/src/file-mutation-transform.ts` | PR3 | 正常执行与 evidence 共用 transform |
| `packages/runtime/src/prepared-file-mutation.ts` | PR3 | 收缩成 evidence preparation，不拥有 replace |
| `packages/runtime/src/local-file-checkpoint-carrier.ts` | PR3 | 收缩成 bounded observer/evidence carrier |
| `packages/runtime/src/worker-backed-file-checkpoint-carrier.ts` | PR3 | worker-owned inspect/prepare；无 host fallback |
| `packages/runtime/src/durable-tool-execution.ts` | PR3 | 仅保留 effect-aware unsettled boundary 所需部分 |
| `packages/runtime/src/builtin-tools.ts` | PR3 | Write/Edit production recovery mode 与 transform |
| `packages/runtime/src/edit-replace.ts` | PR3 | 唯一 Edit transform owner |
| `packages/runtime/src/file-write-lock.ts` | PR3 | 同进程排序；文档明确不是外部 CAS |
| `packages/runtime/src/tool-runtime.ts` | PR3 | T1 前 evidence、T1 后原 worker execution |
| `packages/runtime/src/runtime-commit-sink.ts` | PR3 | 将受校验 evidence 内嵌 canonical dispatch，并与 T1 原子提交 |
| `packages/runtime/src/filesystem-worker/client.ts` | PR3/PR4 | operation 属 PR3；process owner 属 PR4 |
| `packages/runtime/src/filesystem-worker/operations.ts` | PR3 | bounded inspect/transform 请求 |
| `packages/runtime/src/filesystem-worker/protocol.ts` | PR3 | 最小 request/response schema |
| `packages/runtime/src/filesystem-worker/worker-entry.ts` | PR3/PR4 | handler 属 PR3；shutdown 属 PR4 |
| `packages/runtime/src/index.ts` | PR1/PR2/PR3 | 每个 PR 分别追加导出 |

### 明确不迁移的原型

| 文件 | 归属 | 处理 |
|---|---|---|
| `packages/runtime/src/git-file-checkpoint-carrier.ts` | DEFER | Phase 4A Git workspace carrier，不属于文件证据 PR |
| `packages/runtime/src/restricted-verification.ts` | DEFER | 没有独立生产需求前不固化 |

### Storage

| 文件 | 归属 | 处理 |
|---|---|---|
| `packages/storage/src/sqlite-runtime-schema.ts` | PR1/PR2 | PR1 capability/schema；PR2 claim migration 另升版本 |
| `packages/storage/src/sqlite-runtime-store.ts` | PR1/PR2 | recovery bundle 与 continuation claim 按 table/API 分开 |
| `packages/storage/src/agent-run-store.ts` | PR1/PR2 | PR1 禁写 facts；PR2 JSONL/legacy admission |
| `packages/storage/src/execution-stores.ts` | PR4 | store owner 与 close order |

## 6. 测试 extraction ledger

测试移植顺序固定为：先在目标 PR 写出 RED 的 production-shaped test，再移植最小生产代码。禁止先搬
helper/implementation，再让旧测试适配它。

### PR1 tests

| 测试文件 | 处理 |
|---|---|
| `packages/core/src/__tests__/runtime-event.test.ts` | 已在 PR A 重写 exact fact decode/reject |
| `packages/runtime/src/__tests__/recovery-resolver.test.ts` | 逐 case 对账；fact corruption/outcome/sticky 已重写 |
| `packages/runtime/src/__tests__/runtime-event-read-model.test.ts` | recovery fact invisible-row 已重写 |
| `packages/runtime/src/__tests__/tool-recovery-fact-writer.test.ts` | DROP；split writer 不存在 |
| `packages/storage/src/__tests__/sqlite-runtime-store.test.ts` | atomic rollback/idempotency/rebuild/order 已重写 |
| `packages/storage/src/__tests__/agent-run-store.test.ts` | JSONL/append/import/terminal gate 已重写 |
| `packages/storage/src/__tests__/sqlite-session-metadata-store.test.ts` | schema coexistence/migration expectation 已重写 |

### PR2 tests

| 测试文件 | 必须保留的黑盒场景 |
|---|---|
| `packages/runtime/src/__tests__/runtime-continuation.test.ts` | one source boundary → one claim；chain identity |
| `packages/runtime/src/__tests__/runtime-continuation-crash.test.ts` | claim crash window、restart、并发双 resume |
| `packages/runtime/src/__tests__/runtime-resume.test.ts` | immutable high-water、ancestor replay、suffix policy |
| `packages/runtime/src/__tests__/runtime-resume-crash.test.ts` | plan/execute revalidation 跨重启 |
| `packages/runtime/src/__tests__/session-manager.test.ts` | 只提取 continuation/clone/cancel cases |
| `apps/desktop/src/main/__tests__/runtime-resume-routing-contract.test.ts` | startup/manual 同 boundary 不重复 |
| `packages/core/src/__tests__/runtime-event.test.ts` | 只追加 continuation refs schema case |
| `packages/storage/src/__tests__/sqlite-runtime-store.test.ts` | durable claim uniqueness 与 migration |
| `packages/storage/src/__tests__/agent-run-store.test.ts` | legacy/JSONL 明确降级或拒绝 |

### PR3 tests

| 测试文件 | 处理 |
|---|---|
| `packages/runtime/src/__tests__/tool-recovery-contract.test.ts` | 提取 registry/identity/mode mismatch 黑盒 case |
| `packages/runtime/src/__tests__/tool-recovery-coordinator.test.ts` | 重写串行、部分成功、park、atomic bundle |
| `packages/runtime/src/__tests__/file-tool-recovery.test.ts` | 重写 after→finalize，before/other→park |
| `packages/runtime/src/__tests__/restricted-verification.test.ts` | DEFER |
| `packages/runtime/src/__tests__/prepared-file-mutation.test.ts` | 重写 evidence preparation；删除 replace/redo 假设 |
| `packages/runtime/src/__tests__/prepared-file-recovery.test.ts` | 重写 finalize-only crash matrix |
| `packages/runtime/src/__tests__/prepared-file-t2-crash.test.ts` | 保留 replace/执行后、T2 前崩溃的 reopen 收敛 |
| `packages/runtime/src/__tests__/prepared-file-runtime-resume-e2e.test.ts` | 重写真实 builtin→T1→crash→reopen→resume |
| `packages/runtime/src/__tests__/builtin-tools-prepared-file.test.ts` | 保留生产 definition/transform/return shape |
| `packages/runtime/src/__tests__/builtin-tools-file-worker.test.ts` | worker ownership、permission profile、abort signal |
| `packages/runtime/src/__tests__/tool-runtime-durable-boundary.test.ts` | T1 前业务错误走正常 tool result；T1 后未知保持 unsettled |
| `packages/runtime/src/__tests__/tool-runtime-sqlite-boundary.test.ts` | real builtin recovery mode + SQLite evidence |
| `packages/runtime/src/__tests__/local-file-checkpoint-carrier.test.ts` | bounds、symlink、trusted workspace、metadata observation |
| `packages/runtime/src/__tests__/filesystem-worker-client.test.ts` | worker protocol 与 process failure |
| `packages/runtime/src/__tests__/file-write-lock.test.ts` | 同进程 per-file serialization；不声称外部 CAS |
| `packages/runtime/src/__tests__/session-manager-tool-recovery.test.ts` | resume 入口真实 reconcile/replan |
| `packages/runtime/src/__tests__/session-manager.test.ts` | 只提取 PR3 wiring cases |

### PR4 tests

| 测试文件 | 必须保留的黑盒场景 |
|---|---|
| `packages/cli/src/__tests__/runtime-bootstrap.test.ts` | 初始化失败、正常退出、取消、双 close |
| `apps/desktop/src/main/__tests__/runtime-resume-routing-contract.test.ts` | background promise rejection 被 owner 收敛 |
| `packages/runtime/src/__tests__/filesystem-worker-client.test.ts` | spawn 失败与 shutdown |
| `packages/runtime/src/__tests__/session-manager.test.ts` | owner close 时 in-flight recovery 处理 |

## 7. Extraction 操作顺序

每个 PR 都从当时最新的 `upstream/main` 建立平铺分支：

```text
git fetch upstream
git switch --create codex/runtime-resume-prN upstream/main
```

禁止：

- cherry-pick merge commit；
- cherry-pick 同时覆盖两个不变量的 commit；
- 从 #1346 checkout 整个目录；
- 为了让旧测试通过重新引入已删除的 public API。

允许：

- 用 `git show <old>:<path>` 阅读；
- 用 `git diff <old> -- <path>` 定位旧行为；
- 手工重写 production-shaped test；
- 从单一旧 commit 提取一个独立 hunk，但 commit message 必须写明来源。

每个 test case 在 ledger 中记录：

```text
old test name
→ target PR
→ disposition: rewritten | migrated | superseded | deferred | dropped
→ new test name/path
→ verification command
```

## 8. Diff 审计

### 已执行的 PR1 range-diff

```text
git range-diff --stat \
  0aabde97..origin/codex/runtime-resume-phase3a \
  upstream/main..codex/runtime-recovery-authority
```

结果：

- 39 个旧 non-merge commit 均显示为 removed；
- 3 个 PR A commit 均显示为 added；
- 没有 commit 被伪装成等价 cherry-pick。

这证明 PR A 是重写，不证明语义无丢失。因此还必须做路径和测试场景审计。

### 已执行的 PR1 路径级 diff

对 core fact、resolver/read-model、SQLite/JSONL store 与相关测试做 old-head ↔ PR A path diff：

```text
1061 insertions, 2534 deletions across 17 PR1-relevant old paths
```

主要有意删除：

- `tool-recovery-fact-writer.ts`；
- `tool-recovery-facts.ts`；
- 旧 split-writer tests；
- contract/reconcile/continuation/file 行为。

主要新增：

- core `tool-recovery-fact.ts`；
- core `tool-recovery-bundle.ts`；
- atomic bundle capability；
- completed/parked idempotency；
- physical `event_seq` causality。

### 每个后续 PR 的必做命令

```text
git range-diff <old-source-range> upstream/main..<new-pr-head>
git diff --stat <old-head> <new-pr-head> -- <owned-paths>
git diff --name-status upstream/main...<new-pr-head>
git log --no-merges --name-only upstream/main..<new-pr-head>
```

验收不是“行数相同”，而是 owned invariant 的黑盒场景全部有去向，且目标 PR 没有出现其他 PR 的路径。

## 9. Production-shaped crash gates

### PR1

- fail after reconcile insert；
- fail after outcome insert；
- exact completed/parked retry；
- close/reopen then rebuild；
- completed without outcome；
- same-timestamp facts use `event_seq`；
- JSONL/generic import/terminal writer bypass attempts。

PR A 当前差额：上述 `after_recovery_reconcile` 与 close/reopen→rebuild→resolve 两项未完成；
在两项通过前不得把 ledger 标为 extracted。

### PR2

- claim durable 前/后崩溃；
- startup resume 与手动 resume 并发；
- second-generation continuation；
- ancestor interrupted text/thinking suffix；
- mutable partial snapshot 与 immutable cursor 分离；
- clone with recovery refs：正确 rewrite 或明确拒绝。

### PR3

- evidence durable 前/后崩溃；
- `recoveryMode=reconcile` 但 T1 缺少/伪造 prepared evidence → 整个 T1 拒绝；
- normal worker execution 后、T2 前崩溃；
- restart observe expected-after → finalize；
- restart observe before → durable `reconcile_not_applied` + `redo_disabled_pending_cas` park，
  证明不会 redo；
- external drift/symlink/oversize/invalid UTF-8 → park；
- permission/preflight 业务错误 → 标准 tool error result；
- Write 的 before 与 expected-after 相同 → T1 前按确定性 no-op 正常结算；
- Edit 的 `old_string === new_string` → 保持生产 Edit 的标准 preflight error；
- real builtin + worker + SQLite + SessionManager reopen。

### PR4

- store 打开后 worker 初始化失败；
- worker 打开后 registry 初始化失败；
- in-flight recovery 时 SIGINT/app quit；
- close 被调用两次；
- background resume reject 不产生 unhandled rejection；
- Desktop 与 CLI 同 workspace owner 冲突。

## 10. #1346 关闭条件

PR1–3 合并并满足各自 crash gate 后：

1. 在 #1346 最后评论列出 replacement PR URLs；
2. 明确哪些原型没有迁移：Git carrier、restricted verifier、auto redo、retry/reattach；
3. 将 #1346 保持 Draft 并关闭，不 squash/merge；
4. PR body 和讨论保留，作为设计与 review 历史；
5. PR4 可独立继续，不阻塞 #1346 关闭。
