# Managed Workspace Source Branch Publish v1

## 目标

把 managed workspace 的 accepted tree 安全交付到原 Git repository，同时不修改用户当前 checkout、`HEAD`、index 或任何已有 ref。

该切片不实现原地 Apply。它只创建 owner 命名空间下的新分支：

```text
managed accepted tree
        +
source baseline commit
        ↓
deterministic source commit
        ↓
CAS refs/heads/maka/<publish-id>
```

非 Git source 不具备 source branch，继续使用 isolated restore/export。

## Owner 与权限

- `GitoxideManagedSourceBranchPublishOwnerInternal` 固定 source path、managed repository path、source baseline commit/tree；调用者只能提交有界 `publishId`。
- Runtime Host 只给 Git source 签发该 owner；filesystem snapshot source 的能力为 `undefined`。
- 短生命周期 Gitoxide helper 是 object copy、commit construction 和 ref CAS 的唯一执行者。
- helper capability 必须显式包含 `publish_accepted_tree_to_source_branch`。

调用者不能选择目标 repository、base commit/tree、accepted commit/tree 或任意 ref。

## 证明链

1. 从 durable accepted-head authority 读取 accepted commit/tree。
2. 在 managed repository 中验证 accepted commit、tree 和完整 policy-v3 tree。
3. 在 source repository 中验证冻结的 source baseline commit 及其 exact tree。
4. 按共享预算把 accepted tree/blob 写入 source object database，并逐 object 验证 OID。
5. 以固定 author、timestamp、message、source baseline parent 和 accepted tree 构造确定性 commit。
6. 只允许 `refs/heads/maka/<publish-id>`，并以 `MustNotExist` CAS 发布。
7. 已存在且指向同一 commit 时视为 exact replay；其他目标一律 conflict。

## 原子性边界与失败状态

唯一 publication point 是 target ref CAS。

| 失败位置 | Durable 状态 | 恢复 |
| --- | --- | --- |
| object copy 前/中 | 最多存在不可达 content-addressed object | 使用同一请求重试 |
| commit 写入后、ref CAS 前 | 存在不可达确定性 commit | 重试得到同一 commit |
| ref CAS 后响应丢失 | ref 已精确指向 published commit | 重试返回 `replayed: true` |
| target ref 指向其他 commit | 外部或冲突 publication | fail closed，不覆盖 |

rollback 不删除 object，也不回退 checkout；不可达 object 由后续 GC 回收。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | SHA-1 Git source；object copy、确定性 commit、ref CAS、真实 helper kill/retry |
| macOS | 与 Linux 相同的协议和 fail-closed 行为；由 CI real-helper lane 持续验证 |
| Windows | 相同 API、ref CAS 和 checkout 不变；进程终止由共享 child-process lifecycle owner 负责 |

SHA-256 repository 继续在 admission 阶段明确拒绝。v1 不声明 power-loss durability；它证明 process-crash convergence。

## 非目标

- 不 checkout 新分支。
- 不修改当前 branch、working tree 或 index。
- 不自动 merge/rebase source 的后续提交。
- 不为 filesystem snapshot source 伪造外部 Git repository。
- 不在本切片实现 object GC；M4 GC owner 将 unreachable objects 作为回收对象。
