# Managed Coding v2 Product Composition

## 1. 为什么是 v2

`managed-coding-v1` 已经是持久化 Session 合同：它只有 accepted-world `Read/Glob/Grep/Write/Edit`。直接把
新工具塞进 v1，会让同一 durable profile 在不同版本拥有不同权限，也会让旧 Session 因新 toolchain/sandbox 缺失而
突然无法打开。

因此 v1 保持冻结，v2 只增加一个能力：

```text
ManagedNodeTest(explicit sorted .js/.mjs/.cjs files)
```

它不是 Bash、npm script 或任意 command；它只能观察同一个 accepted Git tree。

## 2. 主要不变量

> `managed-coding-v2` 只有在一个 Runtime Host 同时拥有 accepted Gitoxide session、current-process Node
> toolchain、enforcing sandbox 与 storage-root execution capability 时才可组合；缺一项必须在 T1 前明确不可用。

v2 工具集合固定为：

```text
Read / Glob / Grep / Write / Edit / ManagedNodeTest
```

- Read/Glob/Grep：`replay_safe`，读取 accepted tree；
- Write/Edit：`reconcile + managed_mutation_v1`；
- ManagedNodeTest：`replay_safe + managed_observation_v1`；
- Bash、npm、package script、PATH executable 与 attached checkout 均不在 profile 内。

## 3. Owner 与组合顺序

1. Host boot 尝试 admission packaged Gitoxide helper 与 current-process managed toolchain；缺失只让对应 profile
   unavailable，不让普通 Session 获得 fallback；manifest 损坏仍 fail Host boot。
2. Session run 开始时，Gitoxide owner读取 durable epoch/head/version。
3. v2 additionally 组合 command sandbox owner、execution-root owner 与 Node-test admission owner。
4. Run composer 将 exact profile 工具投影给模型，同时把 mutation/observation admission 分别交给 Runtime。
5. Runtime 在 T1 前冻结 mode；T1 后不允许换回 v1、普通 test runner 或 generic T2。

## 4. 失败与兼容

- 旧 `managed-coding-v1` Session 永远不要求 Node toolchain；
- v2 缺 Gitoxide/toolchain/sandbox：run 在 provider 请求前以
  `managed_workspace_profile_unavailable` 失败；
- v2 test admission 失败：没有 T1；
- T1 后 helper/Host 失败：按 `managed_observation_v1` exact-boundary recovery 收敛；
- profile 是 Session immutable identity，不允许运行中从 v2 降级 v1。

本切片建立 Host 产品 composition，但不立即把 Desktop 默认创建策略从 v1 切到 v2。默认切换必须与 packaged
Host/helper kill-reopen 和三平台 enforcing sandbox gate 同一交付完成，避免用户拿到未经证明的默认能力。

## 5. Production-shaped crash gate

默认切换前的 crash gate 不使用同进程异常模拟：

1. 使用仓库锁定的 Electron/Node 24 启动真实 Runtime Host；
2. 使用真实 packaged Gitoxide helper、managed-command manifest 与平台 sandbox；
3. provider 发出一次 `ManagedNodeTest`，并在看到 durable tool result 后挂起；
4. 测试强杀整个 Host root process；
5. 第二个 Host 从 SQLite、accepted Git tree 和 continuation facts 自动继续；
6. provider 不得再次发出工具调用，RuntimeEvents 中只能有一对 `function_call/function_response`。

测试由 Gitoxide 三平台 workflow 持有。没有真实 helper 的本地构建只能明确 skip，不能把 skip 计作 crash 证据。

## 6. 平台矩阵

| 平台 | composition 语义 | 默认启用前 gate |
| --- | --- | --- |
| Windows | v2 profile 与 owner graph 可组合 | packaged Electron + AppContainer/Job + kill/reopen |
| macOS | 相同 durable profile | signed app + Seatbelt + kill/reopen |
| Linux | 相同 protocol/build | signed distribution authority + Bubblewrap + kill/reopen |
