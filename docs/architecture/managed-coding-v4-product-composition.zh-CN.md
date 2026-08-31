# Managed coding v4 product composition

status: packaged product gate

milestone: M5 workspace transform

## 1. 主要不变量

Desktop 只能在 resident Runtime Host 于 Session 创建前宣告 `managed-coding-v4` 时选择该 profile。v4 精确包含
v3 的 Read/Glob/Grep/Write/Edit/ManagedNodeTest/ManagedNodeRun，再加入 `ManagedNodeTransform`。旧 v1/v2/v3
Session 的工具集合和 durable protocol 不变；运行过程中禁止从 v4 降级到早期 profile。

## 2. Authority chain

```text
packaged release v4 manifest
  -> current-process toolchain capability
  -> enforcing command sandbox owner
  -> v4 Gitoxide managed session owner
  -> ManagedNodeTransform admission
  -> managed_mutation_v3 T1
  -> canonical mutation execution profile v2
  -> Gitoxide candidate
  -> SQLite successor acceptance
```

release manifest v4 同时绑定 `hermetic_observation_v2`、`hermetic_observation_v3` 和
`workspace_transform_v1`。v3 或更旧 manifest 必须 fail closed；caller 不能只靠路径或 environment 打开 transform
effect class。

Write/Edit 的 `managed_mutation_v2` payload 与 transform 的 `managed_mutation_v3` payload 只区分 operation proof
字段；二者统一绑定 canonical mutation execution profile v2 digest。旧 mutation profile v1 没有生产消费者，本交付
不读取、不迁移，也不保留 profile-set fallback。

## 3. Crash boundary

production-shaped gate 使用真实 packaged Electron Host、Gitoxide helper、Node sandbox、provider tool call 与 SQLite：

1. transform 生成 exact output；
2. SQLite 已提交 T2/successor、provider 已观察 tool result，但 assistant turn 尚未结束；
3. kill 整个 Host；
4. 新 Host 自动 continuation；
5. 只能观察到一个 call、一个 response、一个 successor、零 active reservation；
6. transformer 不得第二次执行。

accepted ref promotion 若在 kill 时尚未完成，只允许从 durable successor 重放 projection。

## 4. 平台矩阵

| 平台 | v4 availability |
| --- | --- |
| Linux | packaged manifest v4 + enforcing sandbox + real Host crash gate 后可宣告 |
| macOS | packaged manifest v4 + enforcing sandbox + real Host crash gate 后可宣告 |
| Windows | 当前 Electron runtime 不作为独立 admitted Node runtime；只宣告 v1，v4 明确 unavailable |

本合同只承诺 process-crash convergence，不承诺硬件断电 exactly-once。
