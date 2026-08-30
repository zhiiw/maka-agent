# Managed Workspace GC v1

## 主要不变量

GC 只能删除已经失去恢复根资格、且位于 Maka-owned restore `orphans/` 下的 artifact。当前 accepted head、published ref、active restore、历史 WorkspaceVersion 和 continuation evidence 均不在 v1 删除范围内。

## Owner 与原子边界

- GC owner 从固定 storage root + epoch 推导唯一 orphan root，不接受调用者路径。
- 只接受真实非 symlink 目录；inventory 与单次删除数量都有硬上限。
- 删除前先原子 rename 为 `.gc-*` tombstone；进程中断后下一轮优先收敛 tombstone。

## 失败、保留和平台

rename 失败或身份不可信时 fail closed。Linux/macOS/Windows 均使用相同 tombstone 协议；Windows 文件占用使删除失败时保留 tombstone，下一次重试。v1 只回收 restore orphan，candidate/ref/object 的 reachability GC 要在其全部 durable roots 可枚举后另行扩展。

真实子进程测试会在 orphan 已 rename 成 tombstone、尚未删除时终止进程。新进程只识别固定 orphan root 下的 `.gc-*`，并以同一有界批次继续删除。进程退出不会重新物化 accepted tree，也不会触碰 active restore、accepted ref、published ref 或历史版本。

v1 采用保守 retention：无法证明不属于 durable root 的对象一律保留。它因此可能暂时多占磁盘，但绝不会为了降低空间占用而缩短 Resume、Review、历史恢复或 publication 的证据寿命。
