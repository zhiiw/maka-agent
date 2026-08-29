# Managed Workspace Isolated Restore v1

## 主要不变量

一次 restore 只把 SQLite authority 指向的 accepted Git commit/tree 物化到 Maka-owned 隔离目录；它绝不修改用户 checkout，也不把目录内容提升为新的事实源。

## Owner 与原子边界

- SQLite workspace head/version：决定唯一 accepted commit/tree。
- 短生命周期 Gitoxide helper：从该 immutable tree 生成 staging 目录。
- Runtime Host restore owner：持久化 intent，完成 `staging -> workspace` rename，再写 receipt。

进程崩溃后，任何残留 staging 或无条件复用风险的旧 workspace 都整体 rename 到 `orphans/`，随后从 accepted tree 重建。owner 不沿可替换子路径递归删除用户字节。

## 失败状态与回滚

- helper 启动前失败：accepted truth 不变，无用户 checkout 副作用。
- helper 中途退出：partial staging 在下次调用时进入 orphan 区。
- rename 后、receipt 前退出：旧 workspace 在下次调用时进入 orphan 区，再重建。
- receipt 完成：结果可消费；再次请求仍重新物化，以避免信任可能被外部修改的 projection。

v1 只承诺进程崩溃收敛，不声明断电后的字节持久性。orphan 的保留与配额由 M4.6 GC owner 管理。

## 平台矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | 支持 exact accepted-tree materialization 与 process-crash convergence |
| macOS | 支持 exact accepted-tree materialization 与 process-crash convergence |
| Windows | 支持 exact accepted-tree materialization；被占用目录导致 rename 失败时 fail closed |

