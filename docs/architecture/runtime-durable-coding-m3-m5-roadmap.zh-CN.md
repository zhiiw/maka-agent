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
| immutable Publish | artifact/ref protocol 已实现 | 已实现 | accepted ref 与 source branch publish 已接入 Desktop Review | real-helper process response-loss/reopen 已建立；packaged Desktop matrix 待 CI |
| isolated Restore | artifact protocol 已实现 | 已实现 | 已接入 Desktop Review | real-helper process response-loss/reopen 已建立；packaged Desktop matrix 待 CI |
| time travel | historical read/restore/undo successor 已实现 | 已实现 | 最近 50 个版本、隔离恢复与 Undo 已接入 Desktop | lineage 与 history-successor crash tests 已建立 |
| rebaseline / relocation | epoch activation identity 已实现 | 已实现 | Rebaseline 已接入 Desktop | Host crash cases 已建立，packaged evidence 待 CI |
| GC | restore-orphan 与 mutation-candidate retention owner 已实现 | 已实现 | Desktop maintenance v2 入口已接入 | restore/candidate ref-response-loss tests 已建立；history candidate 与 physical object compaction 待后续保守证明 |
| dependency snapshot / Node tests | immutable snapshot、sandbox、T1/T2 settlement 已实现 | 已实现 | Host profile 协商后普通 workspace task 自动选择最高可用 profile | Linux/macOS Host kill/reopen 已建立；Windows 明确只提供 v1 |
| general Bash / external effects | shell correlation/recovery kernel 已实现 | 组合入口尚未闭合 | **缺失** | 外部 acceptance/fencing matrix **缺失** |

表中的“已实现”指当前 fork stack 的代码状态，不表示相关 PR 已经合并或发布。

## 3. M3 — Task continuity

### M3 的产品不变量

> 一个 Desktop coding task 的模型输入、工具读取、工具写入和 continuation 必须属于同一个 accepted
> workspace causal boundary；Host 退出后只能从 durable facts 创建一个新 Run，不能重放已经完成的副作用。

M3 的 Git/非 Git自动 admission、accepted-world tools、automatic continuation 与 quiet park UI 已在当前 stack
闭合。剩余交付门槛是把产品形状证据持续放入发布矩阵，而不是再造协议：

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

当前 Desktop 已接入 isolated restore：Review 面板签发稳定 `restoreId`，Runtime Host 只从 managed session 的
durable accepted identity 物化到 Maka-owned restore root。响应丢失后复用同一 ID；已有 staging/workspace 会先转成
orphan，再从 accepted tree 重建。它不读取或覆盖 source checkout。Undo-as-successor 已实现；可分页完整
timeline 仍属于后续能力。

Desktop 也已接入 bounded accepted history：Host 从一次 captured head 沿 immutable parent records 反向读取，最多
返回 50 个版本；任一 repository/workspace/epoch mismatch、断链或循环都 fail closed。用户可以选择旧版本恢复到
隔离目录，或以旧 tree 创建新的 accepted successor；两者都不 rewind 历史。可分页完整 timeline 仍属于后续能力。

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
单一 storage-root owner 管理。首版不执行或捆绑 package manager：只导入用户显式选择、已经存在的 npm
`node_modules`，以 source/copy/receipt 三次一致的内容 identity 发布 immutable lease。缺少依赖时明确 unavailable；
不得借用 `PATH`、联网安装或静默读取 source checkout。未来 installer 是独立 producer，不改变 snapshot 合同。

### M5.4 Durable build/test

build/test 默认属于 hermetic observation：从 accepted tree + dependency lease 运行，输出结构化 stdout/stderr、
exit status、test summary 与 artifact digest。缓存是 projection；test outcome RuntimeEvent 才是恢复事实。

落地分两步，避免在 M5.3 供应链未拍板前重新引入 bundled npm：

1. `run_node_tests_v1` 先执行 accepted tree 内显式 Node tests，不安装依赖、不读取 PATH，也不借用 source checkout
   的 `node_modules`；它证明 test runner、sandbox 与有界结构化 observation；
2. durable protocol boundary 已在 T1 前绑定 accepted head、workspace epoch、测试文件 identity、
   toolchain/profile 和 effect class；Runtime 以线性 operation capability 和单一 immutable result snapshot 写入
   T2；
3. Host admission owner 已只从 Gitoxide accepted-world 与 toolchain opaque capability 签发 envelope，并用一次性
   input/scratch roots 执行显式 Node tests；
4. `managed-coding-v2` Host composition 已定义版本化工具集合，并保持 v1 不变；真实 Electron Host/helper
   kill-reopen 已进入平台 gate；Desktop 在 Session/T1 前查询 resident Host capability，Linux/macOS 选择 v2，
   Windows 当前只获得 v1，禁止执行时降级；
5. 需要外部包的项目在 M5.3 capability 可用前明确 unavailable，禁止静默降级。

当前下一步采用更窄的 `ManagedNodeRun` kernel：只运行 accepted tree 中的显式 Node 入口，exact argv 在 T1
前冻结，写入仅限 disposable scratch。它不等同于 Bash，也不发现 package scripts 或 `PATH` 工具。kernel
完成后，独立产品组合切片才把 `managed-coding-v3` 加入 Host negotiation，并用真实 Host kill/restart 证明
完成结果不重放。详见 `managed-hermetic-node-command-kernel-v1.zh-CN.md`。

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

1. **M3 release evidence**：packaged Desktop Git/非 Git quiet-resume crash matrix；
2. **M4 lifecycle proof**：为 Publish/source-branch publish、Restore、Undo、Rebaseline 与 maintenance 统一补齐真实
   Host kill/reopen matrix；
3. **M4 durable-root GC**：mutation candidate ref/receipt 已按 current/active operation roots 安全退役；后续独立枚举 active epoch、pending continuation、accepted/published/history refs、restore/apply receipts 与审计保留 roots，再考虑 physical object compaction；
4. **M5 profile negotiation**：Host capability set 与 Desktop pre-Session selection（当前切片）；
5. **M5 foreground command loop**：把 accepted tree、dependency snapshot、sandbox command 与 shell recovery 组合成
   可由产品调用的 build/test loop；
6. **M5 workspace transform**：只写 owner output tree，经 candidate + SQLite acceptance 进入 accepted history；
7. **M5 external effects**：idempotency/fencing/reconciliation；
8. **M5 full loop**：Desktop product composition 与跨平台 crash matrix。

每个 PR 必须列出 owner、原子性边界、失败状态、回滚/收敛方式和平台矩阵。CI 全绿只表示已布置用例通过；
并发、崩溃与数据安全仍需单独论证。
