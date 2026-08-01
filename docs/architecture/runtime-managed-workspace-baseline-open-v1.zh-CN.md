# Managed Workspace Baseline Open v1：M0 最终接受门

- 状态：实现中；前置 Git Workspace Service、Workspace Version Authority 与 Managed Workspace Owner
  合并后从最新 `main` 平铺重建
- 更新日期：2026-08-02
- 主要不变量：只有经 Git artifact owner 持久化并重新验证的 exact baseline receipt，才能由同一
  storage-root lifecycle owner 提交给 SQLite workspace authority；Git artifact 单独成功不构成
  canonical workspace version
- Git artifact owner：`GitWorkspaceService`
- composition/lifecycle owner：`ManagedWorkspaceOwner`
- canonical history owner：SQLite 内 immutable workspace RuntimeEvents

## 1. 本切片交付什么

前三个 M0 切片已经分别证明：

1. Maka 可以用 pinned Git 创建、验证、repair 和 quarantine 自有 Git repository/worktree artifacts；
2. SQLite 可以把 epoch-opened、baseline-accepted 与三个 projection 原子提交，并从 RuntimeEvents 重建；
3. 一个 authenticated interactive storage root 只发布一个 managed workspace lifecycle owner。

它们之间仍缺一个权限与因果门。如果调用者可以把任意 OID 直接交给 SQLite，那么 Git 验证只是注释；
如果 Git 创建成功就被当作 canonical，那么 SQLite 失败后会出现第二套 workspace truth。本切片只关闭这条
seam，不接 Desktop、CLI、runtime host 或工具执行。

公开入口是：

```ts
owner.openManagedWorkspaceBaseline(runtimeStore, {
  repositoryId,
  workspaceId,
  workspaceEpochId,
  workspaceInstanceId,
  sourceRoot,
  policyHash,
});
```

调用者只提供业务身份、source root 与 policy hash，不能提供 commit/tree OID、version ID、event ID、
tree delta 或“verified”布尔值。

## 2. Owner、原子边界、失败状态与回滚

| 项目 | 决策 |
|---|---|
| Git artifact owner | `GitWorkspaceService` 独占 receipt 创建、持久化、读取和重新验证 |
| lifecycle owner | `ManagedWorkspaceOwner` 独占 Git receipt → SQLite authority 的组合调用 |
| canonical truth | SQLite authority stream 的 immutable RuntimeEvents；receipt 是 admission evidence，不是 canonical head |
| Git durability boundary | `baseline-receipt.json` 以同目录临时文件、file fsync、rename、POSIX parent fsync 持久化 |
| SQLite atomic boundary | epoch fact、baseline fact、epoch/version/head projection 位于同一事务 |
| root binding | authority store 的数据库目录必须等于 authenticated storage root；错误 DB fail closed |
| exact retry | durable receipt 冻结 version/event IDs、timestamp 与 delta；重试不能重新生成 identity |
| pre-accept orphan | receipt 已落盘而 SQLite 未接受时，它是可重试 orphan；不是 canonical workspace version |
| post-accept loss | SQLite 已有 head 但 receipt 缺失、漂移或 Git artifact 不可验证时，报 corruption/unavailable，不生成替代 receipt |
| 回滚 | 停止调用本入口即可；既有 RuntimeEvents 仍可读。不能删除已接受 receipt 来“回滚” canonical history |

本切片没有尝试跨 Git filesystem 与 SQLite 建立一个不真实的分布式事务。它使用可重放协议收敛：Git
receipt 先 durable，SQLite 后原子接受；唯一允许的半完成状态是“未被接受的 Git orphan”。反方向的
“SQLite 已接受但 Git receipt 不存在”不是可修复半状态，而是 fail-closed corruption。

## 3. Durable receipt 合同

receipt 位于 managed instance root，和 `binding.json` 同级：

```text
managed-workspaces/
  w/<workspace>/e/<epoch>/i/<instance>/
    binding.json
    baseline-receipt.json
    worktree/
```

v1 receipt 严格包含：

```ts
{
  schemaVersion: 1,
  protocol: 'maka_managed_workspace_baseline_receipt_v1',
  binding,
  workspaceVersionId,
  policyHash,
  epochOpenedEventId,
  baselineAcceptedEventId,
  committedAt,
  treeDeltaDigest,
  changedFileCount,
  deletedFileCount: 0,
}
```

所有字段采用 exact-key strict decoder。receipt 必须重新证明：

- durable binding 与调用 identity 完全相同；
- repository record、epoch artifact、baseline ref、head ref、commit/tree 与 pinned Git capability 一致；
- worktree registration 仍被 Maka ownership lock 锁定；
- HEAD/tree 等于 baseline，worktree clean；
- policy hash 与首次 receipt 一致；
- tree delta 摘要与 baseline tree 重新计算结果一致。

## 4. Tree delta 摘要

M0 baseline 的逻辑 parent 是 empty tree，因此：

- `changedFileCount` 等于 baseline tree 的受支持 blob entry 数；
- `deletedFileCount` 固定为 `0`；
- `treeDeltaDigest` 是 domain-separated canonical manifest 的 SHA-256，而不是 caller 自报值。

manifest 按 Git `ls-tree -r -z` 的 canonical 顺序记录每个 entry 的 `mode`、`objectType`、`oid` 和
`path`。M0 只接受普通 blob mode `100644` / `100755`；symlink、submodule、special mode、
`.gitattributes` 与 case collision 继续由 Git Workspace Service 在 receipt 生成前拒绝。

该摘要证明的是 Git object delta，不是 checkout 文件字节扫描，也不把 ignored/untracked 内容纳入
canonical baseline。

## 5. 正常时序

```mermaid
sequenceDiagram
  participant C as "Storage composition caller"
  participant O as "ManagedWorkspaceOwner"
  participant G as "GitWorkspaceService"
  participant R as "baseline-receipt.json"
  participant S as "SqliteRuntimeStore"
  participant E as "Workspace RuntimeEvents"

  C->>O: openManagedWorkspaceBaseline(store, identity + policyHash)
  O->>O: authenticate root lease; assert store belongs to same root
  O->>G: create/adopt and verify managed workspace
  G->>G: verify binding/repository/epoch/ref/worktree
  G->>G: derive canonical empty-tree → baseline delta
  alt receipt already exists
    G->>R: strict read + exact revalidation
  else no canonical head and receipt absent
    G->>R: atomic durable write of frozen receipt
  end
  G-->>O: verified durable receipt
  O->>S: internal commitWorkspaceBaseline(receipt-derived input)
  S->>S: BEGIN IMMEDIATE
  S->>E: epoch-opened + baseline-accepted
  S->>S: epoch/version/head projections
  S->>S: COMMIT
  S-->>O: created or exact-existing head
  O->>G: post-commit reverify exact receipt and Git artifacts
  G-->>O: verified
  O-->>C: usable canonical baseline
```

只有最后一步成功返回以后，调用者才得到可用的 managed baseline。SQLite commit 后的 reverify 失败
不会撤销 canonical history；它阻止当前 instance 被交给后续工具，并要求 repair/quarantine 流程处理。

## 6. Crash 与并发矩阵

| 崩溃/并发点 | durable Git 状态 | canonical SQLite 状态 | 重启结果 |
|---|---|---|---|
| receipt durable 前退出 | 无 receipt 或原子旧值 | absent | 重新验证 Git 后重新生成 receipt |
| receipt durable 后、SQLite 前退出 | exact orphan receipt | absent | exact reuse receipt，再提交 authority |
| epoch/version/projection 事务中退出 | exact receipt | 全回滚 | exact retry；不生成新 IDs |
| SQLite COMMIT 后、返回前退出 | exact receipt | accepted | 重读 head + require existing receipt；exact existing |
| accepted 后 receipt 缺失 | missing | accepted | fail closed；禁止创建 replacement receipt |
| accepted 后 receipt 篡改 | invalid/drifted | accepted | fail closed；canonical history 不变 |
| accepted 后 Git ref/object/worktree 漂移 | unverifiable | accepted | fail closed，后续 quarantine/repair；不返回 cwd |
| 两个进程同时首次打开 | artifact lock 串行并复用同一 receipt | SQLite writer 串行 | 一个 created，一个 exact existing |
| 相同 identity、不同 policy | 首个 receipt 胜出 | 首个 baseline 胜出 | 另一个 identity conflict |
| owner 传入另一 storage root 的 DB | 不写 receipt | 不写错误 DB | admission 前拒绝 |

真实进程 crash harness 覆盖 receipt durable 后、SQLite authority 前的 `SIGKILL`，重启后使用同一
receipt 完成接受。SQLite 事务内部的 process-kill/rollback 证明继续由 Workspace Version Authority
测试拥有；本切片不复制第二套数据库 crash harness。

## 7. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| pinned Git artifact revalidation | 支持 | 支持 | 支持 |
| receipt file fsync + atomic rename | 支持 | 支持 | 进程崩溃支持；不承诺断电级 parent fsync |
| SQLite atomic baseline acceptance | 支持 | 支持 | 支持 |
| real-process crash test | 发布门槛 | 发布门槛 | 有限支持；依赖 Node/Git 的 SIGKILL 等价行为 |
| power-loss durability | 不承诺 | 不承诺 | 不承诺 |

Windows 上不虚构 POSIX directory fsync 承诺。M0 保证进程崩溃后的可重试状态收敛；机器断电、磁盘缓存
或文件系统损坏不在 v1 发布证明内。

## 8. 明确延期

- Desktop、CLI、runtime-host 与设置入口；
- 工具 cwd 切换、ignored dependency/scratch provisioning；
- mutation candidate ref、T1/T2 + workspace version 原子接受、conditional redo；
- continuation 绑定 workspace version 与自动 resume；
- orphan receipt/ref/object GC；
- replication、跨端同步、publish、undo 与 multi-agent merge。

这些能力必须分别由后续 PR 证明自己的 owner、原子边界、失败状态与回滚方式。M0 完成只代表系统拥有
一个可验证、可重试、canonical 的 managed baseline，不代表 agent 已经在该 worktree 中执行工具。

## 9. 验收门槛

- 首次 open 与 exact retry 返回同一 receipt/head；
- receipt-after-write crash 与 SQLite rollback 都能 exact retry；
- accepted 后 receipt missing/tampered fail closed；
- authority store root mismatch 在 Git/SQLite 写入前拒绝；
- Git service、owner、workspace authority 的 focused real-Git/crash suites 全绿；
- `@maka/core` / `@maka/storage` build 与 `git diff --check` 通过；
- 不包含 Desktop/CLI/runtime-host 生产接线。
