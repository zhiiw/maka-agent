# Managed workspace continuation admission v1

## 范围

本切片只证明一个主要不变量：

> 对 `managed-coding-v1` 会话，continuation claim 必须同时绑定不可变 RuntimeEvent replay 边界和当前已接受的 Gitoxide workspace head；任一边界变化都不得启动 provider。

它不改变 provider replay 的 high-water 语义，也不创建新的 workspace baseline。

## Owner 与事实源

- RuntimeEvent replay 边界由 SQLite continuation authority 从不可变事件前缀签发。
- accepted workspace 边界由 workspace version authority 从 epoch、head、version 和 storage-root binding 重建。
- Runtime Host 只负责重新观测 Gitoxide `refs/maka/accepted`，并证明它与 SQLite head 一致。
- `ContinuationClaimV2` 使用 domain-separated digest 绑定上述两个边界；target Run 使用 `continuation_source_v3`，同时保留独立的 replay manifest digest。

调用者不能提交裸 workspace digest，也不能用 v1 claim 替代 v2 claim。

## 原子性边界

SQLite 在一个事务中校验：

1. immutable RuntimeEvent prefix；
2. storage-root binding；
3. workspace epoch/head/version；
4. claim target identity；
5. continuation claim 的唯一性。

claim 与 continuation-start 是两个 durable 边界。若进程停在两者之间，recovery 只能在重新观测到完全相同的 workspace boundary 后写入 repair start；它不会调 provider。

## 失败状态与回滚

- workspace head、accepted ref、receipt 或 storage root 不一致：park / fail closed。
- workspace-bound authority 缺失：park；禁止回退 v1。
- v2 claim 已提交、start 未提交：创建或核对 claim 中的 target Run，写 repair start，再写可审计失败终态。
- normal start 已提交但 provider 状态未知：保持 indeterminate，不自动重放 provider。
- claim 事务内崩溃：SQLite 回滚，不留下半 claim。

## 平台能力

| 平台 | 本切片承诺 |
| --- | --- |
| Linux | SQLite claim/start 原子性；Gitoxide accepted-ref 重验；process-crash 收敛 |
| macOS | 与 Linux 相同；路径以 `realpath` 后身份为准 |
| Windows | SQLite claim/start 原子性；Gitoxide accepted-ref 重验；不依赖 POSIX inode 语义 |

断电持久性沿用 SQLite/Gitoxide owner 各自已经声明的平台合同，本切片不扩大承诺。

## 交付状态

这是 stacked Draft。Desktop/CLI 自动 continuation 仍受现有 feature gate 控制；在 production-shaped Host kill/reopen 证据进入三平台 recovery inventory 前，不转 Ready。
