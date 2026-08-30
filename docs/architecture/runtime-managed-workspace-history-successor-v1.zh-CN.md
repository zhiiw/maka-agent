# Managed Workspace 历史 successor v1

## 主要不变量

恢复到旧版本不是移动或回退 `refs/maka/accepted`，而是创建一个新的 accepted successor：

```text
A -> B -> C
     \    \
      target -> D(tree = B.tree, parent = C)
```

旧的 A/B/C 仍然不可变。D 的 parent 是恢复发生时的当前 head，D 的 tree 精确等于目标历史版本的 tree。

## Owner 与权限

- Gitoxide helper 只拥有 `create_history_candidate` 与 `promote_history_candidate` 两个有界操作。
- Runtime Host history owner 冻结 restore ID、当前 head、目标版本和候选 ref。
- Execution Stores 只接受由该 owner 通过 `WeakMap` capability 签发的候选 proof；外部调用者不能提交裸 successor descriptor。
- SQLite RuntimeEvents 是 accepted history 的唯一事实源；workspace version/head 表仍是可重建投影。

## 原子性边界

1. Gitoxide 从当前 accepted commit 与历史目标 tree 构造 immutable candidate commit。
2. SQLite 在一个事务中写入 history fact、version projection，并用 head revision CAS 推进 canonical head。
3. SQLite 提交后，Gitoxide 用 accepted ref CAS 将 projection 推进到 candidate commit。

Git ref 与 SQLite 不能形成一个跨系统事务。因此 durable 线性化点是第 2 步；第 3 步是可幂等重放的 projection。

## 失败状态与恢复

- candidate 发布前失败：没有 accepted fact，调用可安全重试。
- candidate 已存在、SQLite 尚未接受：严格验证 commit parent/tree/message/signature 后精确重试。
- SQLite 已接受、ref 尚未推进：新 Host 从 history fact 的 parent、target、candidate identity 重建 promotion，只推进 ref，不重新执行恢复。
- accepted ref 已被其他 head 推进：CAS fail closed，不覆盖新的 accepted world。
- 目标版本不属于同一 repository/workspace/epoch，或 policy 不一致：在 candidate 发布前拒绝。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | Gitoxide candidate、SQLite crash/reopen、ref CAS 与真实进程退出恢复 |
| macOS | 与 Linux 使用相同协议；由 release recovery lane 持续验证 |
| Windows | 协议、SQLite 与 ref CAS 相同；完整 Host crash lane 必须持续报告显式证据，不得用 skip 冒充承诺 |

## 非目标

- 不修改用户 checkout。
- 不删除旧 accepted commits 或历史版本。
- 不把一次历史恢复伪装成 Write/Edit outcome。
- 不在本切片中实现长期 GC、Publish 冲突处理或 rebaseline。
