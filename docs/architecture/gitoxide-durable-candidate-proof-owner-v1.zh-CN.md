# Gitoxide durable candidate proof owner v1

## 1. 目的

#3857 的 `GitoxideCandidateOutcomeCapability` 是正确的进程内权限边界，但它由 `WeakMap` 绑定 owner，Host 重启后不能直接恢复。v1 在不扩大 Git 写权限的前提下，把同一个 operation-bound candidate 记录成可重验的 durable receipt。

本切片不推进 accepted head，不写 RuntimeEvent outcome，也不物化 filesystem projection。

## 2. 主要不变量

> 一个 candidate 只有在 #3857 的 accepted repository capability 下生成、与当前 durable base head 完全匹配、且其完整 proof 已原子写入 storage-root-owned receipt 后，才可交给后续 successor acceptance owner。

owner 分工：

- Gitoxide accepted-tree owner：持有 repository、accepted ref、candidate ref 和 Git object identity；
- Runtime Host receipt owner：持有 storage-root write lease，决定 receipt 路径和 durable publication；
- SQLite successor owner：不在本切片内，后续只能消费 receipt owner 签发的 opaque proof；
- Runtime：不在本切片内，仍拥有 Write/Edit 参数和 provider result。

## 3. API 权限

receipt owner 只接受：

- owner-bound `GitoxideAcceptedRepositoryCapability`；
- durable `WorkspaceHeadRecordV1`；
- operation id、canonical path、纯 transform result content 和固定 execution profile。

它不接受：

- 裸 repository path；
- 任意 accepted/candidate ref；
- caller 提交的 commit/tree/blob OID；
- caller 提交的完整 successor descriptor。

所有 Git identity 都从 #3857 candidate capability 中提取。

## 4. Durable receipt

receipt 严格绑定：

- repository/workspace/epoch/version/base accepted event/revision；
- base commit/tree；
- operation identity hash；
- helper artifact hash、tree policy、request digest；
- disposition（published/no-change）；
- candidate ref/commit/tree、result blob；
- canonical path、result content hash、execution profile。

receipt 使用严格 key set、固定版本、32 KiB 上限、非 symlink regular-file 读取和文件身份重验。写入顺序为：

```text
Git candidate ref publication
  -> receipt temp write + fsync
  -> atomic rename
  -> receipt parent fsync
```

## 5. 崩溃状态

| 状态 | 含义 | 恢复 |
| --- | --- | --- |
| 无 ref、无 receipt | 未开始 | 正常执行纯 transform/candidate 请求 |
| 有 ref、无 receipt | Git 已发布，receipt 前崩溃 | 用同一纯请求重放；#3857 必须返回同一 candidate，再写 receipt |
| 有 ref、有匹配 receipt | 已准备 | 在 exact base capability 下直接重开新的进程内 proof，不重算 transform |
| 有 ref、有冲突 receipt | corruption/identity conflict | fail closed，不覆盖 receipt |
| receipt 存在但 ref/proof 不匹配 | durable evidence 与 Git 分叉 | fail closed；后续 recovery owner 决定 park |

ref-only/receipt 前重放只重做确定性的 Git candidate 请求，不重放 live filesystem side effect；receipt
已经持久化后则直接采用 receipt，不再重做 transform 或 candidate creation。

## 6. 平台合同

| 平台 | v1 承诺 |
| --- | --- |
| Linux | process-crash convergence；receipt file/parent fsync；non-symlink bounded read |
| macOS | process-crash convergence；不声称 `F_FULLFSYNC` 级断电持久性 |
| Windows | process-crash convergence；依赖同目录 rename 和 storage-root owner；不声称断电事务 |

三平台都必须运行 ref-only kill/reopen 测试后，才能把本能力用于 production Write/Edit。

## 7. 延期项

- candidate GC/discard tombstone；
- accepted ref 推进；
- projection；
- Desktop/CLI consumer；
- power-loss durability；
- SHA-256 repository。
