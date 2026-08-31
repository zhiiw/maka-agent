# Managed Node Test Admission Owner v1

## 1. 范围

本切片把 durable `ManagedNodeTest` protocol 连接到两个已经存在的 authority：Gitoxide managed session 的
accepted head，以及 managed command sandbox 的 opaque toolchain capability。它只建立 Runtime Host admission；
不会把工具加入现有 `managed-coding-v1`，不会改变普通 Session，也不会在缺少 enforcing sandbox 时回退到
`node`、`npm`、package script 或 `PATH`。

## 2. 主要不变量

> 一次 Node test 的 T1 只能引用同一个 durable accepted head 物化出的精确文件，以及同一个受权
> `hermetic_observation_v2` toolchain 与显式 `none`/opaque dependency snapshot lease；T1 以后 accepted input
> 或 dependency identity 漂移必须 fail closed。

具体约束：

1. caller 只能提供排序、唯一、canonical 的显式 `.js/.mjs/.cjs` 路径；
2. Gitoxide session owner 从 SQLite epoch/head/version 重建 repository、workspace、epoch、instance、accepted
   event/revision/commit/tree，不接受 caller 自报 identity；
3. materializer 在写 input root 前后重新观察 accepted boundary，并验证 helper 返回的 commit/tree；
4. command owner 从 opaque toolchain capability 提取 digest 和 Node version；admission 不接受 executable path；
5. 每个测试文件在 T1 前通过 command owner 固化 bytes/SHA-256；
6. admission 签发一次性 execution capability。它只能从 `ready -> running -> complete -> disposed` 前进；
7. test helper 返回的文件集合必须与 T1 的文件 identity 完全相同；
8. input/scratch root 只属于该 operation，结算或失败后由 admission owner 清理。

## 3. Owner 与原子性边界

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| Gitoxide managed session | accepted epoch/head/version 与 exact-tree materialization | toolchain、T1/T2、test result |
| Command sandbox owner | verified toolchain、文件 observation、process-tree 与 sandbox profile | accepted head、Runtime result publication |
| Execution-root owner | storage-root write lease、一次性 roots 的完整生命周期 | accepted head、toolchain、T1/T2 |
| Admission owner | 三种 capability 的组合、T1 envelope | 任意 filesystem path 删除、SQLite writer、Desktop profile 选择 |
| Runtime | 线性 operation、immutable result snapshot、T1/T2 publication | Git/toolchain identity 的真实性 |

Admission 在所有 accepted-world/toolchain/file preflight 完成后才返回 durable envelope。SQLite T1 仍由 Runtime
现有 `commitToolPrepared()` 原子写入；本切片不增加 table、projection 或第二个 writer。

Admission 不接收裸 `storageRoot`。execution-root owner 必须持有不可伪造的 write lease，并在 admission 从分配
到 dispose 的完整生命周期内保持该 lease 的 inflight operation；Host drain 因而不能在活跃 test root 尚未清理时
先关闭 storage-root owner。

## 4. 失败与收敛

- accepted boundary、materialization 或 toolchain 不可证明：T1 前拒绝并删除 operation root；
- materialized commit/tree 与 admission observation 不一致：T1 前拒绝；
- T1 后 input 文件 identity 变化：helper 不运行或结果被拒绝，进入 durable observation 的 fail-stop/recovery；
- operation 运行中 abort/timeout：等待 command owner 回收 process tree，然后清理 roots；
- T2 已提交但 live response 丢失：采用 immutable RuntimeEvent outcome，不重新解释 helper stdout；
- Runtime 在 operation callback 返回 Host owner 以前提交精确 T2；owner response 丢失、提前返回或后续 live
  publication 失败，都不得触发 generic T2 或重新运行 test；
- T1 已提交但 T2 缺失：后续 recovery 只能在同一 accepted commit/tree、文件、toolchain/profile 上重建；任一
  identity 漂移都 park，禁止 generic test fallback。

本切片的 rollback 仅存在于 T1 前：删除 disposable operation root。T1 后不得删除 durable fact 伪装回滚。

## 5. 平台矩阵

| 平台 | 当前切片证明 | 转为产品能力前仍需证明 |
| --- | --- | --- |
| Linux | exact Gitoxide source owner 与 Host admission contract | Bubblewrap enforcing helper + Host kill/reopen |
| macOS | 相同 identity/protocol contract | Seatbelt enforcing helper + Host kill/reopen |
| Windows | 相同 identity/protocol contract；compiled Host owner tests | packaged AppContainer/Job owner + full Host kill/reopen |

本地环境若无法构建目标平台 Rust helper，可以运行纯 Host owner tests；真实 Gitoxide materialization 必须由仓库现有
三平台 helper CI 执行。CI 绿只证明已布置测试，不替代 sandbox 与 crash 论证。

## 6. 后续产品接线

不要静默扩大 `managed-coding-v1`。后续独立切片应定义版本化 product profile，只有在 packaged/current-process
toolchain authority、enforcing sandbox 和 production-shaped crash test 同时可用时，才把 `ManagedNodeTest` 暴露给
Desktop。旧 profile 与旧 session 的工具集合保持冻结。
