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
- `operation_failed_no_effect_committed`：纯转换在接触 Git candidate 前确定失败；
- `unsettled`：无法证明以上任一终态，保留 reservation 并 fail-stop。

前两种 no-effect terminal 由同一个 SQLite writer 原子提交 exact T2、terminal fact 并释放
reservation；generic T2 writer 在数据库层拒绝 managed mutation。

## 原子性与恢复

`promote_candidate` 的线性化点是 accepted ref 的 compare-and-swap：

- `accepted == base`：推进到 exact candidate；
- `accepted == candidate`：视为精确重试并成功收敛；
- 其他状态：fail closed，不覆盖、不 fallback。

因此 SQLite 提交后、ref 推进前崩溃时，只重放 ref projection，不重新执行 Write/Edit。

## 失败状态与回滚

- candidate 创建失败：不产生 accepted successor；保留或清理由 candidate 生命周期 owner 处理。
- no-op / 确定性转换失败：不创建 candidate；SQLite 原子提交 no-effect terminal 并释放 reservation。
- SQLite successor 未提交：禁止推进 accepted ref。
- accepted ref CAS 冲突：park；SQLite accepted truth 保留，等待显式 reconciliation。
- projection 失败：不得回滚 SQLite 事实，也不得重跑工具。

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
