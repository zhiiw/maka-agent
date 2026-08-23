# Gitoxide Write/Edit 接受链 v1

## 状态

API-only stacked Draft。此切片先证明 Git 数据面的两个必要边界，不代表 Desktop/CLI 已开放 managed Write/Edit。

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

## 原子性与恢复

`promote_candidate` 的线性化点是 accepted ref 的 compare-and-swap：

- `accepted == base`：推进到 exact candidate；
- `accepted == candidate`：视为精确重试并成功收敛；
- 其他状态：fail closed，不覆盖、不 fallback。

因此 SQLite 提交后、ref 推进前崩溃时，只重放 ref projection，不重新执行 Write/Edit。

## 失败状态与回滚

- candidate 创建失败：不产生 accepted successor；保留或清理由 candidate 生命周期 owner 处理。
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

本切片之后仍需把 Runtime-owned outcome、SQLite successor writer 和 ref projection 串成一个生产 session owner，并补“SQLite 已提交、projection 前杀 Host、重启后只推进 ref”的真实进程测试。完成前保持 Draft，也不进入 M3 的自动恢复策略。
