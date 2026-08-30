# Managed Workspace Desktop Undo v1

## 目的

Desktop 的历史面板提供两个彼此独立的动作：

- **恢复隔离副本**：把历史版本物化到新的隔离目录，不改变 accepted head；
- **设为新的当前版本**：以当前 accepted commit 为 parent、以所选历史版本的 tree 为内容，创建新的 immutable successor。

Undo 不回退 `refs/maka/accepted`，也不删除中间历史。若历史为 `A → B → C`，在 C 上选择 A 后得到 `A → B → C → D(A.tree)`。

## 主要不变量

同一个 `(workspace epoch, restoreId, targetWorkspaceVersionId)` 只能产生一个 accepted history successor。Desktop 不拥有 Git ref、SQLite head 或 candidate 的写权限，只能提交经过 Runtime Host 协议验证的意图。

## Owner 与原子边界

| 层 | Owner | 权限 |
| --- | --- | --- |
| Desktop | Review panel + IPC adapter | 生成稳定 `restoreId`，请求 Undo，刷新历史 |
| Runtime Host | `GitoxideManagedHistorySuccessorOwnerInternal` | 创建/验证 Gitoxide candidate，提交 successor，投影 accepted ref |
| SQLite | workspace history authority | 在一个事务中写 RuntimeEvent、version projection 和 head CAS |
| Gitoxide helper | 短生命周期 helper | 创建确定性 commit，并对 accepted ref 做 exact CAS |

SQLite successor commit 是 accepted truth 的线性化点。Git ref 是可重建投影；若进程在 SQLite commit 后退出，相同 `restoreId` 的重试只重放 projection，不再创建另一条 successor。

## 失败状态与回滚

- candidate 创建前失败：没有 durable 状态，调用失败；
- candidate 已创建、SQLite 未接受：candidate 是未接受派生物，不得成为当前版本；
- SQLite 已接受、ref 未投影：返回失败；精确重试收敛到同一 successor；
- target、epoch、policy 或当前 head 不匹配：fail closed，不回退到隔离恢复或直接 ref rewind；
- Desktop/IPC 断开：不会改变 owner 的 durable 决策；用户可用相同 `restoreId` 重试。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | Gitoxide candidate、SQLite acceptance、exact retry；真实 helper crash seam 进入恢复测试 |
| macOS | 实现与协议目标与 Linux 相同；合并前仍需由 macOS real-helper recovery lane 提供发布证据 |
| Windows | 协议、SQLite acceptance、Desktop/IPC 行为一致；合并前仍需可发布 Gitoxide helper 的完整 Host kill/restart 证据 |

该动作不写用户 checkout，因此不存在 checkout apply 冲突；把 accepted history 发布回用户 checkout 属于独立 Publish/Apply owner。
