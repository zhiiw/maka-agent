# Desktop Managed Source Branch Publish v1

## 目标

让 Git-backed Managed Task 在 Review 面板中把当前 accepted tree 发布成源仓库的新分支，同时不修改用户 checkout、HEAD、index 或已有 ref。

非 Git Managed Task 不显示该操作；它继续使用隔离恢复能力。

## Owner 与权限边界

- Desktop 只生成并保留一个 `publishId`，并展示结果。
- Runtime Host protocol 把请求固定为 `refs/heads/maka/<publishId>`，调用者不能指定任意 ref。
- `GitoxideManagedSourceBranchPublishOwnerInternal` 是唯一发布 owner；Desktop、preload 和 IPC 都不能直接访问源仓库。
- accepted content 来自 managed repository 的 accepted ref，源仓库 parent 来自该 task 冻结的 source baseline。

## 原子性边界

目标 ref 的 compare-and-swap 是唯一发布点：

- CAS 前崩溃：最多留下不可达的 content-addressed objects；相同 `publishId` 可重试。
- CAS 后响应丢失：相同请求读取并返回同一 commit/ref，`replayed=true`。
- 目标 ref 已存在但 identity 不匹配：fail closed，不覆盖。

Desktop IPC 不增加第二套事实或 receipt，只转发严格 operation 并展示 authority 返回的 receipt。

## 失败状态与回滚

- helper/capability 不可用：操作失败，accepted history 不变。
- filesystem-snapshot source：操作不显示；Host 端仍二次拒绝。
- source baseline、accepted tree 或 target ref 冲突：操作失败，用户 checkout 不变。
- UI 丢失响应：重试复用相同 `publishId`，不创建第二个分支。

不需要对 source checkout 执行回滚，因为本协议从不修改它。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | Git-backed task 可发布新分支；checkout 不变；exact retry |
| macOS | 同 Linux；路径由 admission authority canonicalize |
| Windows | 同 Linux；不通过 shell 或系统 Git 执行 |

三平台都依赖已验证的短生命周期 Gitoxide helper；没有 helper capability 时 fail closed。
