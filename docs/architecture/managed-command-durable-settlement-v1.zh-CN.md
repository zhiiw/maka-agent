# Managed Command Durable Settlement v1

## 1. 范围

本切片只收紧 `ManagedNodeTest` 的 durable result publication。它不增加新的命令种类，不允许 Bash、npm、
网络或任意外部副作用，也不改变 dependency snapshot、toolchain 或 sandbox 的 admission 规则。

## 2. 主要不变量

> Managed observation 的 Runtime-owned operation 一旦产生规范化结果，Runtime 必须在把控制权交还 Host owner
> 之前提交精确 T2；T2 成功后，owner response、UI message 或 provider publication 丢失都不得触发工具重跑，
> 也不得以 generic synthetic failure 覆盖该结果。

结果只存在一个权威来源：Runtime 在 operation callback 内生成的 bounded strict-JSON immutable snapshot。Host
owner 只拥有 admission、sandbox/process-tree 生命周期和 execution roots，不拥有 result 内容或 T2 writer。

## 3. Owner 与原子性边界

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| Admission owner | accepted input、toolchain/dependency capability、sandbox/process-tree、一次性 execution roots | provider result、T2 writer、重放结论 |
| Runtime operation | 线性 `open -> running -> settled -> closed` capability、结果 snapshot | Git/toolchain identity 的真实性 |
| SQLite RuntimeEvent writer | T1/T2 的唯一 durable writer 与 exact retry | live UI/provider publication |
| UI/provider projection | 已提交 RuntimeEvent 的展示 | durable truth、工具重试权限 |

线性化边界是 operation callback 内的 `commitOutcome()`：

```text
T1 committed
  -> admission owner invokes the one-shot operation
  -> sandboxed test completes
  -> Runtime snapshots the result
  -> Runtime commits exact T2
  -> operation callback returns to the Host owner
  -> live UI/provider publication
```

Host owner 即使在 callback 返回后丢失响应，Runtime 仍采用已提交 T2。若 owner 提前返回，Runtime 必须 join 已经
启动的 operation；只有该 operation 已经提交精确 T2 才能继续。owner 无法通过 early return 创建 detached test。

## 4. 失败状态与收敛

- T1 前 admission/preflight 失败：工具未运行，不产生 managed T1；
- T1 成功、operation 尚未完成：保留 durable prepared 状态，后续只按相同 identity 恢复；
- operation 完成但 T2 commit 失败：不发布 live success，保留 unsettled 状态；
- T2 成功、owner response 丢失或抛错：采用 T2，禁止重跑；
- T2 成功、UI/provider publication 失败：T2 保持唯一事实，当前 live turn fail-stop，continuation 从 T2 重建；
- cleanup 失败：不得改写 T2；owner drain 继续负责回收一次性 roots/process tree。

该 observation 是只读操作，没有 workspace rollback。T1 后也不得通过删除 RuntimeEvent 伪装回滚。

## 5. 崩溃证据与平台矩阵

`managed-coding-v2` packaged Host crash gate 已覆盖：真实 Host、Gitoxide accepted tree、opaque dependency lease、
enforcing command sandbox、真实 Node test、T2 durable publication、Host kill/reopen 和 exact replay。该 gate 必须证明
同一 call 只有一个 durable response，重启后不会重新运行已完成测试。

| 平台 | 当前合同 |
| --- | --- |
| Linux | process-crash 后从 SQLite T2 重建；工具不重跑 |
| macOS | 与 Linux 相同；由 packaged Seatbelt gate 持续验证 |
| Windows | 与 Linux 相同；由 packaged AppContainer/Job gate 持续验证 |

本切片不宣称 power-loss durability，也不宣称任意 Bash 或外部服务 exactly-once。外部副作用需要独立的 acceptance
evidence、idempotency key/fencing 或 fail-closed park 协议。

