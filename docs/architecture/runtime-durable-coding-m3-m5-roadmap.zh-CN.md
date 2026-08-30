# Durable Coding M3–M5 交付路线

## 1. 目标与统一模型

这条路线不再把 Git 项目、非 Git 目录和文件级 checkpoint 作为三套产品模式。Desktop 对普通
project/host-path task 自动执行 source admission：Git repository 导入 exact commit/tree，普通目录导入
bounded filesystem snapshot；两者随后共享同一个 accepted Git object model。

```text
source observation
  -> immutable accepted baseline
  -> RuntimeEvent + accepted-head causal boundary
  -> Read/Glob/Grep/Write/Edit
  -> review/publish/restore lifecycle
  -> controlled command/test/external-effect execution
```

RuntimeEvents 是执行语义事实；SQLite transaction 决定 accepted head；Gitoxide objects 保存 immutable
workspace content；materialized directory、Desktop UI 和缓存都只是可重建 projection。

## 2. 能力状态账本

每项能力分成四层，避免把“存在一个 owner”误报成“产品已经可用”。

| 能力 | Durable kernel | Host owner | Desktop consumer | Crash/recovery proof |
| --- | --- | --- | --- | --- |
| Git/非 Git source admission | 已实现 | 已实现 | 已自动接入 | Git/非 Git helper matrix 已建立 |
| accepted Read/Glob/Grep | 已实现 | 已实现 | managed tool profile 已接入 | helper/Host 用例已建立 |
| Write/Edit successor | 已实现 | 已实现 | managed tool profile 已接入 | candidate + Host kill/reopen 已建立 |
| automatic continuation | 已实现 | 已实现 | quiet resume 已接入 | Git/非 Git indeterminate matrix 已建立 |
| accepted-tree Review | 不写 durable state | 已实现 | 已接入 Desktop Review | helper exact-tree + IPC fail-closed test 已建立 |
| immutable Publish | artifact/ref protocol 已实现 | 已实现 | 已接入 Desktop Review | helper ref-CAS + IPC fail-closed test 已建立；packaged Desktop crash proof 缺失 |
| isolated Restore | artifact protocol 已实现 | 已实现 | **缺失** | helper tests 已建立，Desktop crash proof 缺失 |
| time travel | historical read/restore 已实现 | 已实现 | **缺失** | undo-as-successor 尚未实现 |
| rebaseline / relocation | epoch identity 已实现 | 已实现 | **缺失** | Host cases 已建立，packaged evidence 待 CI |
| GC | restore-orphan tombstone 已实现 | 已实现 | 无需直接 UI | candidate/ref/object roots 尚未纳入 |
| Bash / dependency / tests | 仅有旧 storage authority 与通用 shell 基础 | **缺失** | **缺失** | **缺失** |

表中的“已实现”指当前 fork stack 的代码状态，不表示相关 PR 已经合并或发布。

## 3. M3 — Task continuity

### M3 的产品不变量

> 一个 Desktop coding task 的模型输入、工具读取、工具写入和 continuation 必须属于同一个 accepted
> workspace causal boundary；Host 退出后只能从 durable facts 创建一个新 Run，不能重放已经完成的副作用。

M3 已完成主要实现，剩余交付是产品形状闭环而不是再造协议：

1. 用 packaged Desktop + Runtime Host 发起真实 managed task；
2. 分别以 Git repository 和普通目录为 source；
3. 完成 Read -> Edit/Write -> accepted successor；
4. 在 provider 前、T1 后、successor 后三个边界终止 Host；
5. 重启 Desktop，验证 quiet resume、唯一 continuation、已完成 Write/Edit 不重放；
6. park、权限或 source drift 才显示显式用户操作，正常恢复不弹阻断对话框。

M3 exit gate 是上述 Desktop production-shaped matrix 在 Windows/macOS 发布构建中持续执行。Linux 继续证明
Host/helper 合同，但不借此宣称 Linux Desktop 发布物。

## 4. M4 — Workspace lifecycle

### M4.1 Review / Diff

- owner：Gitoxide accepted-tree review owner；
- 原子边界：一次请求绑定 baseline commit/tree 与 accepted commit/tree；
- 失败状态：任一 identity/object/budget 不可证明即 fail closed；
- 产品：Desktop Review 面板直接消费结构化 accepted diff，不调用系统 Git，不读 attached checkout。

### M4.2 Publish / Apply

immutable publish ref 与“应用到用户 checkout”必须分开：

1. Publish 只在 managed repository 内为 exact accepted commit 创建 immutable ref；
2. Apply owner 重新观察用户 checkout baseline、dirty state 和目标分支；
3. checkout 已漂移时只能选择新分支、显示冲突或取消，不能静默覆盖；
4. apply receipt 持久化 source observation、accepted commit/tree、目标 ref 和最终验证结果；
5. 崩溃后只 reconcile receipt/ref/worktree evidence，不重新计算 accepted mutation。

当前 Desktop 已接入第 1 项：Review 面板签发稳定 `publishId`，Runtime Host 只允许
`managed-coding-v1` session 创建 `refs/maka/published/<publishId>`。失败重试复用同一个 ID，ref 不存在或精确指向
accepted commit 是仅有的两种可收敛状态。这个动作不接触 source checkout；Apply 仍由后续独立 owner 负责。

### M4.3 Restore / Undo / Time travel

- isolated restore 永远写入 fresh directory；残留目录先 orphan，再从 accepted tree 重建；
- 历史版本预览只读指定 accepted version；
- Undo 不 rewind 当前 head，而是从历史 tree 创建一个新的 successor；
- Desktop timeline 展示 lineage，不把 projection 当历史权威。

### M4.4 Epoch lifecycle

- Rebaseline 总是创建 new epoch；旧 epoch immutable；
- source relocation 只替换已重新验证的位置 observation，不改变 session/accepted history identity；
- GC roots 至少包含 active task、pending continuation、accepted head、published ref、restore point、apply receipt
  与审计保留策略；
- 只有不属于任何 root 的 candidate、restore orphan、abandoned epoch 和 unreachable objects 才能回收。

M4 exit gate 是 Desktop 可以 Review、Publish/Apply、Restore、Undo、Rebaseline，并在每个 durable publication
边界的真实进程崩溃后收敛。Windows 文件占用必须保留可重试 tombstone；macOS/Linux 使用相同 identity，路径
先 canonicalize。v1 不承诺硬件断电持久性。

## 5. M5 — Full durable coding loop

M5 不把普通 Bash 直接标成可恢复。命令在 T1 前必须被划分到互斥 effect class：

| Effect class | 权限 | 恢复策略 |
| --- | --- | --- |
| `hermetic_observation_v1` | 无网络、只读 accepted input、仅写 disposable scratch | 可从同一 boundary 重建或重跑 |
| `workspace_transform_v1` | 只写 owner-owned output tree | 固化 candidate，SQLite 接受后投影；不原地改 accepted tree |
| `external_effect_v1` | 网络、凭据、远端 API 或不可观察系统状态 | 需要外部 idempotency/acceptance evidence；否则 park，禁止自动重放 |

### M5.1 Toolchain capability

Host 只接受 release/dev owner 签发的 toolchain capability。它绑定 executable bytes、platform/arch、版本、helper
目录、environment policy 和允许的 effect class。PATH、caller executable path 和相邻自签 manifest 都不是
authority。

### M5.2 Command sandbox

command owner 在 spawn 前固定 cwd/input tree、environment、network、credentials、process-tree、time/output/disk
budgets 与 cancellation。无法在某平台证明 profile 时，该 profile 不可用；禁止降级为普通 Bash。

### M5.3 Dependency environment

复核并收窄现有 `ManagedDependencyEnvironmentAuthority`：lockfile、package-manager/runtime identity 与 platform
共同决定 artifact identity；producer 只得到一次性 staging/scratch；active lease、publication、receipt 与 GC 由
单一 storage-root owner 管理。首版只支持明确锁定的 package-manager/profile，不捆绑 Git。

### M5.4 Durable build/test

build/test 默认属于 hermetic observation：从 accepted tree + dependency lease 运行，输出结构化 stdout/stderr、
exit status、test summary 与 artifact digest。缓存是 projection；test outcome RuntimeEvent 才是恢复事实。

### M5.5 External-effect fencing

外部调用必须在 T1 前绑定 operation id/idempotency key、目标 authority 与 reconciliation contract。远端没有
幂等键或 acceptance evidence 时，响应丢失只能 park；不能用本地“已准备”推断远端“未发生”。

### M5.6 Full coding loop

```text
Inspect -> Edit -> Build -> Test -> Observe -> Edit -> Review -> Publish
```

每一步共享 Runtime high-water、accepted head、workspace epoch、toolchain profile 和 effect class。任何一步 kill
Host 后，新的 Run 只采用 durable outcome/candidate/evidence；已完成操作不重放，不确定 external effect park。

## 6. 推荐后续 PR 顺序

1. **M3 closure**：packaged Desktop Git/非 Git quiet-resume crash matrix；
2. **M4 Desktop Review**：结构化 accepted diff 的 IPC 与 UI consumer（已实现，等待三平台 packaged 证据）；
3. **M4 Apply/Publish**：immutable publish Desktop consumer 已实现；下一步是 drift-aware checkout apply receipt；
4. **M4 Restore/Undo**：isolated restore、historical successor 与 timeline；
5. **M4 Lifecycle**：Desktop rebaseline/relocation、完整 durable-root GC；
6. **M5 Toolchain/Sandbox**：能力证明与 hermetic command worker；
7. **M5 Dependencies/Tests**：受权 dependency artifact 与 durable test outcome；
8. **M5 External effects**：idempotency/fencing/reconciliation；
9. **M5 Full loop**：Desktop product composition 与跨平台 crash matrix。

每个 PR 必须列出 owner、原子性边界、失败状态、回滚/收敛方式和平台矩阵。CI 全绿只表示已布置用例通过；
并发、崩溃与数据安全仍需单独论证。
