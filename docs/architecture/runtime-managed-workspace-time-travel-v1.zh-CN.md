# Managed Workspace Time Travel v1

## 主要不变量

历史浏览只接受当前 workspace epoch 内已经持久化的 `WorkspaceVersion`。它把所选 commit/tree 物化为隔离 restore，不移动 `refs/maka/accepted`，也不改写历史。

## Owner、失败与回滚

- SQLite version authority 判断 version 是否属于当前 repository/workspace/epoch。
- Restore owner 复用 M4.2 的 staging、orphan 和 receipt 协议。
- Git accepted ref 在整个操作中保持不变；失败只留下可重建 projection 或 orphan。

v1 先提供可审计的 time travel/restore。把历史状态变成当前状态时，必须创建新的 successor；该 mutation acceptance 不得通过 ref rewind 或直接 checkout 覆盖实现。

三平台均只承诺进程崩溃收敛；Windows 目录占用导致 rotation 失败时 fail closed。
