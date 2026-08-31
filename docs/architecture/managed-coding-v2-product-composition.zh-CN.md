# Managed Coding v2 Product Composition

## 1. Canonical contract

`managed-coding-v2` 是第一版、也是当前唯一的 managed coding Session 合同。此前 integration stack 中出现过的
`managed-coding-v1/v3/v4` 从未发布、没有生产消费者，也没有需要迁移的用户数据；它们不再是可读或可协商协议。

固定工具集合为：

```text
Read / Glob / Grep / Write / Edit
ManagedNodeTest / ManagedNodeRun / ManagedNodeTransform
```

- Read/Glob/Grep：只读取 accepted Git tree；
- Write/Edit/ManagedNodeTransform：`reconcile + managed_mutation_v2`，用 `operationKind` 区分转换；
- ManagedNodeTest/ManagedNodeRun：`replay_safe + managed_observation_v2`，用 `operationKind` 区分测试与命令；
- Bash、PATH executable、联网安装和 attached checkout 不在 profile 内。

## 2. 主要不变量

> Host 只有同时拥有 Gitoxide accepted-world authority、canonical managed toolchain v2、enforcing sandbox、
> dependency/execution-root authority 和对应 admission owner 时，才能在 T1 前宣告 `managed-coding-v2`；缺少任何
> 能力都必须让整个 profile unavailable，禁止回退到旧 profile 或普通工具。

Session header、Host handshake、Runtime admission、durable dispatch 和 release manifest 都只接受 canonical v2。
旧 Draft 标识明确 fail closed，不提供 dual reader、migration 或 downgrade。

## 3. Owner 与组合顺序

1. Host boot 验证 Gitoxide helper 与 managed-command toolchain release v2；manifest 损坏 fail Host boot。
2. Desktop 在创建 Session、任何 T1 之前读取 resident Host 的 exact capability set。
3. Gitoxide owner读取 durable epoch/head/version；toolchain、sandbox 和 dependency owner签发不透明 capability。
4. Run composer把固定工具集合投影给模型，并把 mutation/observation admission交给 Runtime。
5. Runtime 在 T1 前冻结 mode、accepted head、operation kind、args 和 execution profile；T1 后禁止 generic fallback。

## 4. 失败与数据断代

- capability 不完整：Session 创建或 Run admission 明确返回 `managed_workspace_profile_unavailable`；
- preflight 失败：不跨 T1；
- T1 后失败：只按 canonical mutation/observation proof 收敛；
- 旧 Draft SQLite schema 15–17、旧 profile/manifest/payload 不迁移；开发数据库必须备份后清理；
- 正式 main schema 14 只通过一个 migration 15 进入 canonical managed workspace epoch。

## 5. Crash gate 与平台矩阵

真实 gate 必须启动 packaged/current-process Runtime Host、Gitoxide helper、toolchain 和平台 sandbox，强杀整个 Host
process tree 后从 SQLite + accepted Git facts 继续；已完成工具不得重放。

| 平台 | v2 availability |
| --- | --- |
| Windows | 只有完整 AppContainer/Job 与 Host kill/reopen 证据时可宣告，否则整个 v2 unavailable |
| macOS | signed app + Seatbelt + kill/reopen |
| Linux | distribution authority + Bubblewrap + kill/reopen |

平台缺能力时采用“v2 或 unavailable”，不保留较弱 profile 作为兼容层。
