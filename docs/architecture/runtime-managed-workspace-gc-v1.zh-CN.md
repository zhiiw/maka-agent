# Managed Workspace GC v1

## 主要不变量

GC 只能删除已经失去恢复根资格、且位于 Maka-owned restore `orphans/` 下的 artifact。当前 accepted head、published ref、active restore、历史 WorkspaceVersion 和 continuation evidence 均不在 v1 删除范围内。

## Owner 与原子边界

- GC owner 从固定 storage root + epoch 推导唯一 orphan root，不接受调用者路径。
- 只接受真实非 symlink 目录；inventory 与单次删除数量都有硬上限。
- 删除前先原子 rename 为 `.gc-*` tombstone；进程中断后下一轮优先收敛 tombstone。

## 失败、保留和平台

rename 失败或身份不可信时 fail closed。Linux/macOS/Windows 均使用相同 tombstone 协议；Windows 文件占用使删除失败时保留 tombstone，下一次重试。v1 只回收 restore orphan，candidate/ref/object 的 reachability GC 要在其全部 durable roots 可枚举后另行扩展。

