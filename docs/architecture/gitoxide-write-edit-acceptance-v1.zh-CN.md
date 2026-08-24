# Gitoxide Write/Edit 接受链 v1

## 状态

stacked Draft。Runtime Host 已能消费持久化的 `managed-coding-v1` Session profile；Desktop/CLI
尚未提供创建该 profile 的产品入口，因此不能视为默认开放 managed Write/Edit。

## 主要不变量

一次 managed Write/Edit 的内容只能由以下链路产生：

```text
immutable accepted tree
  -> pure Write/Edit transform
  -> immutable candidate ref + durable receipt
  -> SQLite accepted successor transaction
  -> accepted-ref compare-and-swap projection
```

- transform owner 是 Runtime；它复用生产 Edit matcher，但不读取或写入 checkout。
- candidate owner 是 Runtime Host 的 Gitoxide helper authority。
- accepted truth owner 是 SQLite RuntimeEvents；candidate ref 不是 accepted truth。
- projection owner 只有在 SQLite successor 已提交后才能调用 `promote_candidate`。

T1 后只有四种互斥终态：

- `workspace_successor_committed`：成功且产生新 Git successor；
- `no_workspace_change_committed`：成功但结果内容与 base 相同；
- `operation_failed_no_effect_committed`：纯转换失败，或 helper 以稳定 policy reason 证明
  candidate ref 尚未发布；
- `unsettled`：无法证明以上任一终态，保留 reservation 并 fail-stop。

前两种 no-effect terminal 由同一个 SQLite writer 原子提交 exact T2、terminal fact 并释放
reservation；generic T2 writer 在数据库层拒绝 managed mutation。

## 原子性与恢复

`promote_candidate` 的线性化点是 accepted ref 的 compare-and-swap：

- `accepted == base`：推进到 exact candidate；
- `accepted == candidate`：视为精确重试并成功收敛；
- 其他状态：fail closed，不覆盖、不 fallback。

因此 SQLite 提交后、ref 推进前崩溃时，只重放 ref projection，不重新执行 Write/Edit。

Host 重启时，SessionManager 在 generic `app_restarted` terminal 之前调用 managed mutation gate：

- 没有 active reservation 才允许 generic recovery 继续；
- active T1 已由 Gitoxide/SQLite owner 收敛后才允许 Run 封口；
- helper、receipt、ref 或 storage 暂时不可判定时返回 `parked`，Run 保持未封口，等待下一次权威恢复。

这使 RuntimeEvent terminal seal 不会抢在 managed T2/successor 前落盘。

baseline intent 会绑定签发时的 exact Gitoxide helper artifact SHA-256。重开时若 packaged helper
已经升级，当前 v1 不会把新二进制静默接入旧 workspace epoch，而是 fail closed；由后续显式
rebaseline/新 epoch 流程选择升级。这里绑定的是 materialization artifact identity，不把二进制摘要
冒充稳定的语义 execution profile。

本切片对 baseline intent/receipt 的 durable JSON 只承诺进程崩溃后的收敛；它不声明断电持久性。
若后续需要 power-loss contract，文件内容、父目录与 SQLite 提交顺序必须由同一个平台 durability
设计证明，不能从当前 atomic rename 推导出来。

## 失败状态与回滚

- helper 的稳定 tree/content policy rejection：证明 ref 未发布后提交固定、Runtime-owned error outcome，
  原子释放 reservation；
- helper timeout、abort、协议错误、receipt I/O 或 ref publication 附近失败：状态视为
  `publication_indeterminate`，保留 reservation，禁止把它降级成 no-effect；
- no-op / 确定性转换失败：不创建 candidate；SQLite 原子提交 no-effect terminal 并释放 reservation。
- SQLite successor 未提交：禁止推进 accepted ref。
- accepted ref CAS 冲突：park；SQLite accepted truth 保留，等待显式 reconciliation。
- projection 失败：不得回滚 SQLite 事实，也不得重跑工具。

Write/Edit 的 provider result 继续使用生产 `createUnifiedDiff`，其输入和输出分别受 32 KiB 上限；
超限内容自动降级为固定大小的 `file_write`/Edit summary。因而 live 与 recovery 都由同一个纯 transform
生成严格 JSON 结果，不把文件正文写进 durable outcome。

## 平台能力矩阵

| 平台 | 当前承诺 |
| --- | --- |
| Linux | Gitoxide helper 的 candidate CAS 与精确重试；CI 必须运行真实 helper。 |
| macOS | 与 Linux 相同；不在本切片声明断电持久性。 |
| Windows | 与 Linux 相同；不依赖 POSIX rename 或系统 Git。 |

## 后续闭环

Runtime-owned outcome、SQLite successor writer、baseline session owner 与 ref projection 已串入
`managed-coding-v1` Host backend。三平台打包 helper lane 负责证明 Rust import exact retry；
production-shaped 子进程测试会在 SQLite 已提交、projection 尚未推进时杀死执行进程，再由新 owner
重开同一 Session、只推进 exact candidate ref，并验证第二次重开仍停留在同一 revision。

当前仍保持 Draft：Windows 完整证据必须由 CI 实际通过，Desktop/CLI 产品入口尚未开放，M3 也只能在
该 crash seam 稳定后开始绑定 continuation boundary。
