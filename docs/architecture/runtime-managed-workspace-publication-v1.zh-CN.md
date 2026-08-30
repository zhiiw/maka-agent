# Managed Workspace Publication v1

## 主要不变量

一次 publication 只能把当前 SQLite accepted head 固定为 managed repository 内的 immutable `refs/maka/published/*` ref。它不修改 attached checkout、source branch 或远端 repository。

## Owner 与原子边界

- SQLite head/version owner 提供 exact commit/tree。
- Gitoxide helper 重验 commit/tree 后，以 `MustNotExist` 创建 published ref。
- 同名 ref 已指向相同 commit 时 exact replay；指向其他 commit 时 fail closed。

因此 ref 是 accepted truth 的 durable delivery handle，而不是另一套 workspace head。用户 checkout 的 drift-aware apply 将作为后续显式能力实现，v1 不静默降级为直接文件覆盖。

## 失败与平台语义

helper 退出前没有确认 ref 时，重试通过 ref identity 判定成功、冲突或未知；不会触碰用户 checkout。Linux、macOS、Windows 使用相同 Gitoxide ref transaction 合同。v1 只承诺进程崩溃收敛，不声明断电持久性。
