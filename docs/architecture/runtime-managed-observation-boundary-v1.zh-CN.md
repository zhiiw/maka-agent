# Runtime Managed Observation Boundary v1

## 1. 范围

本切片只建立 M5.4 的 durable protocol boundary：一次 `ManagedNodeTest` 在执行以前，必须把 exact accepted Git world、workspace epoch、显式测试文件 identity、toolchain identity、execution profile 与 effect class 一起写入 T1。

它不负责选择 source、物化 input tree、签发 toolchain capability、启动 sandbox helper 或提供 Desktop 按钮。那些能力属于后续 Runtime Host admission/production composition。它也不增加 SQLite table 或 projection；immutable RuntimeEvent 仍是唯一事实源，现有 tool ledger 仍是唯一 T1/T2 writer。

## 2. 主要不变量

一次 durable managed observation 必须满足：

1. durable mode 在 T1 前确定为 `replay_safe`，effect class 固定为 `hermetic_observation_v2`；
2. T1 同时绑定 repository/workspace/epoch/instance、accepted version/event/revision/commit/tree、排序后的测试文件 bytes/SHA-256、toolchain identity digest 与固定 execution-profile digest；
3. persisted function-call `relativePaths` 必须与 owner 冻结的文件集合完全一致，不能在 T1 后换路径；
4. Runtime 独占 operation capability；它只能在 `open -> running -> settled -> closed` 生命周期内调用一次，Host 不能保留 callback 后迟到执行；
5. Runtime 在 helper 返回边界生成一个有界 strict-JSON immutable snapshot。live provider result、T2 content、message 与 replay 都只能读取这一份 value；
6. Host 只能提交 execution proof，不能替换 Runtime 捕获的 provider result；
7. T1 后禁止回退到 Bash、普通 test runner、PATH toolchain 或未持久化的 generic execution profile。

## 3. Owner 与权限

| Authority | 拥有 | 不拥有 |
| --- | --- | --- |
| RuntimeEvent decoder | observation envelope 的 exact shape、policy/version/digest | repository、toolchain 或文件内容 |
| Runtime | operation 的线性生命周期、provider value snapshot、T1/T2 publication | accepted tree 与 toolchain 的真实性 |
| Runtime Host admission（后续） | accepted boundary、文件 identity、toolchain capability、input/scratch roots | Runtime provider result、SQLite terminal fact |
| SQLite tool ledger | call + dispatch 的 T1 原子提交、response 的 T2 原子提交、rebuild | helper process 或 Git projection |

`executionProfileDigest` 不是 caller 字符串。它对应 Core 中冻结的 profile spec；`toolchainIdentityDigest` 必须由 toolchain artifact authority 从 verified executable/entrypoint/runtime identity 计算。后续 Host admission 只能从 opaque capabilities 提取这两个 identity。

## 4. 原子性边界与状态

```text
Host preflight/admission
  -> exact managed observation envelope
  -> SQLite T1(call + dispatch + prepared projection)
  -> one Runtime-owned operation capability
  -> bounded immutable result snapshot
  -> SQLite T2(response + outcome projection)
  -> provider publication
```

SQLite T1 和 T2 各自是单数据库事务；Git/object store、toolchain observation 与 SQLite 不组成跨介质事务。因此所有外部 capability 都必须在 T1 前验证并冻结 identity。T1 之后：

- operation 尚未调用且 owner 失败：提交有界 error T2；没有测试副作用；
- operation 运行中 timeout/abort/协议损坏：当前 observation 失败；因为 accepted input 只读且 scratch disposable，可在同一 accepted boundary 上按 `replay_safe` 重建；
- test assertion 失败：这是可信 observation，提交 `failed > 0` 的正常 T2，不伪装成 transport error；
- T2 已提交但响应丢失：reopen 后采用 immutable response，不重写 T2；
- T1 已提交但 T2 缺失：后续 recovery owner 只能用同一 accepted commit/tree、同一文件 identity、同一 toolchain/profile 重跑，任何 identity 漂移都 park；
- durable envelope malformed 或 tool ledger 因果顺序损坏：fail closed，禁止 generic T2 fallback。

本切片没有另外的 rollback writer。T1 前失败没有 durable tool operation；T1 后由 terminal T2 或 recovery owner 收敛，不能通过删除 RuntimeEvents“回滚事实”。

## 5. 持久化与重建

`managedObservation` 是 `t1_after_preflight_v1` dispatch 的受限字段，只允许：

- tool name：`ManagedNodeTest`；
- recovery mode：`replay_safe`；
- object format：`sha1`；
- operation/effect：`node_test_v2` / `hermetic_observation_v2`；
- 固定 profile digest；
- 1–64 个 canonical、排序、唯一的 `.js/.mjs/.cjs` 文件。

现有 `commitToolPrepared()` 是唯一 T1 writer；现有 `commitToolOutcome()` 是唯一 generic replay-safe T2 writer。SQLite reopen 和 projection rebuild 都重新经过 RuntimeEvent strict decoder 与 tool-ledger scanner。因为没有新增 disposable projection，本切片不升级 schema。

## 6. 平台矩阵

| 平台 | 本切片承诺 | 后续生产门槛 |
| --- | --- | --- |
| Linux | Runtime/SQLite durable identity 与 replay contract | Bubblewrap enforcing helper + kill/reopen |
| macOS | 同一 protocol 与 durable identity | Seatbelt enforcing helper + kill/reopen |
| Windows | 同一 protocol 与 durable identity | packaged AppContainer/Job owner + full Host kill/reopen |

当前 slice 证明跨平台无关的 ledger 与 state-machine 语义，不把 Node Permission Model 冒充 OS sandbox。没有 enforcing sandbox capability 的平台必须在 T1 前返回 profile unavailable，不能签发 managed observation。

## 7. 后续切片

1. Runtime Host admission owner：从 managed session accepted boundary、Gitoxide file identity 与 verified toolchain capability 生成 envelope 和 input/scratch roots；
2. production consumer：注册真正的 `ManagedNodeTest`，禁止普通 Session/Plan Mode 调用；
3. production-shaped crash test：真实 Host/helper 在 helper 完成后、T2 前被 kill，reopen 只能在 exact boundary 上收敛；
4. Linux/macOS/Windows enforcing sandbox smoke；
5. dependency lease 接入后再支持需要外部 package 的 tests，不读取用户 checkout 或 PATH 的 `node_modules`。
