# Managed Coding v3 产品组合

status: stacked Draft

milestone: M5 foreground command loop

## 1. 主要不变量

Runtime Host 只有同时持有 Gitoxide accepted-world authority、经过 release admission 的 Node 24 toolchain、
enforcing command sandbox、`ManagedNodeTest` owner 与 `ManagedNodeRun` owner 时，才允许宣告
`managed-coding-v3`。Desktop 必须在创建 Session、写入任何 T1 以前查询 resident Host 的 capability set，
并冻结最高可用 profile；Session 创建以后禁止回落到 v2、v1、普通 Node、Bash 或 `PATH`。

本切片把 `ManagedNodeRun` kernel 接入真实 packaged Host，但仍不是通用 shell：调用者只能选择 accepted tree
中的显式 JavaScript 入口和 exact argv，不能选择 executable、cwd、environment、Node flags、网络策略、
依赖目录或输出上限。

## 2. Owner 与权限边界

- release owner：生成 `maka_managed_command_toolchain_release_v3`，同时绑定 v2 test 与 v3 command effect class；
- current-process toolchain owner：严格验证 manifest、Node 版本、entry bytes/hash 后签发 opaque capability；
- Gitoxide session owner：提供 immutable accepted tree 与 workspace boundary；
- sandbox/process owner：提供 read-only input、disposable scratch、空 `PATH`、无 child process 和受限网络；
- Runtime：拥有 durable T1/T2 与 provider result；
- Desktop：只能从 Host 公布的有序 capability set 中选择 profile，不能自行声称 v3。

manifest v3 是新的 packaged release envelope，不是 SQLite schema。旧 v2 manifest 会 fail closed；新构建必须重新
生成资源，不做 silent compatibility fallback。

## 3. 原子性边界

pre-Session：

1. Host 完成 Gitoxide、toolchain、sandbox 与 tool declaration composition；
2. Host 返回 canonical profile set；
3. Desktop 选择并写入一个 immutable Session profile。

per-command：

1. admission 在 T1 前冻结 accepted boundary、entry identity、exact argv、toolchain 与 execution profile；
2. Runtime 写入 `managed_observation_v3`；
3. sandbox 只读取 accepted input，并只允许写 disposable scratch；
4. Runtime 将有界 observation 写入 T2；
5. response 丢失时从 durable outcome 恢复，不重新执行命令。

## 4. 失败状态与回滚

- capability 缺失或 manifest 不匹配：Session 创建前报告 profile unavailable，不产生 durable operation；
- T1 前 entry/toolchain/sandbox 失败：清理临时 roots，拒绝 dispatch；
- T1 后命令未形成合法 observation：保留 T1，按 replay-safe observation 协议恢复；
- T2 已提交、Host 随后死亡：新 Host 采用 durable response，禁止再次 spawn；
- cleanup 失败：不改变 T2，由 execution-root maintenance 回收 disposable roots。

## 5. 平台矩阵

| 平台 | v3 产品能力 | 持续证据 |
| --- | --- | --- |
| Linux | 支持 | packaged Electron Host + Gitoxide helper kill/restart gate |
| macOS | 支持 | packaged Electron Host + Gitoxide helper kill/restart gate |
| Windows | 暂不宣告 | 当前只宣告 v1；在独立 Node runtime 与完整网络隔离证据形成前 fail closed |

平台能力不允许通过执行时 fallback 获得。Windows 的缺口是明确的 capability unavailability，不影响既有 v1
managed Write/Edit。
