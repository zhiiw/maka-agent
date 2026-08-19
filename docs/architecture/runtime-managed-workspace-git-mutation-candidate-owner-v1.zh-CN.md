# Managed Workspace Git Mutation Candidate Owner v1

- 状态：M2.2 核心 owner，M2.4 将其输入收紧为 Runtime-owned exact result content；API-only Draft
- 更新日期：2026-08-19
- 主要不变量：只有 Maka 的 Git artifact owner 能把 Runtime-owned transform result 写入 private index 并发布成 operation-bound candidate；worktree 不是 candidate 输入
- owner：既有 `GitWorkspaceService`；不新建第二个 repository/ref writer
- canonical artifact：candidate Git commit/ref + strict durable receipt
- 不做：不写 T2、不推进 SQLite workspace head、不更新 worktree `HEAD`、不接 Desktop/CLI

## 1. 为什么是 candidate，而不是直接提交 head

工具的 result content 还不能直接成为 canonical workspace version。candidate owner 先将它冻结成候选：

```text
accepted base commit
  + declared changed paths
  + exact resulting blob for the sole path
  + fixed candidate policy
  + execution profile digest
        ↓
single-parent candidate commit
        ↓
operation-bound candidate ref
        ↓
durable candidate receipt
```

candidate 只证明“Git owner 对哪一份 exact result content 重算并写入了什么”。只有 M2.4 将它与 T1 identity、工具语义和 M2.1 SQLite
bundle 一起验证并提交后，它才成为 accepted workspace version。

## 2. 权限边界

`GitWorkspaceService` 已拥有 verified Git runtime、repository artifact、worktree ownership lock、固定 Git
config 和 storage-root writer lock。M2.2 通过 storage-internal `WeakMap` capability 增加 `capture/discard`，没有
从 `@maka/storage` package exports 暴露普通 writer。

调用者不能提交自造 commit/tree/ref。owner 必须重新证明：

- binding、repository、epoch artifact 和 Git runtime identity 一致；
- worktree 是非 symlink 目录，common-dir 指向 Maka repository，worktree lock 仍存在；
- worktree `HEAD`、managed head ref、base commit/tree 同时匹配；
- worktree status 必须 clean；projection drift 只能 fail closed 或在 accept 时整体保留，绝不进入 candidate；
- 首版单文件 mutation 的 result content 必须与 worker result blob 匹配，owner 再用 verified Git `hash-object` 重算 OID并写入 private index（删除为 absent）；
- candidate 全树只有普通 blob mode `100644/100755`，没有 symlink、submodule、special mode、属性文件或大小写冲突；
- candidate commit 只有一个 parent，且 commit identity/message 使用固定协议；
- receipt 的 ref、commit、tree、parent、递归文件级 delta digest 和路径集合可从 Git object database 重算；
- receipt 的 workspace policy 必须等于本次从 baseline authority 重验出的 policy，不能信任 receipt 自报。

## 3. 发布协议

候选不修改 worktree 的真实 index。owner 使用 Maka-owned 临时 index：

```mermaid
sequenceDiagram
  participant C as Future Mutation Admission
  participant G as Git Artifact Owner
  participant R as Maka Git Repository
  participant D as Durable Receipt Directory

  C->>G: capture(binding, operation, baseHead, expectedPath, expectedBlob/content, profile)
  G->>G: acquire storage-root writer lock
  G->>G: verify binding, worktree owner, exact base and status
  G->>R: read-tree(base) into private temporary index
  G->>R: hash exact result content; update-index declared path; write-tree
  G->>R: commit-tree(tree, parent=base)
  G->>R: CAS create operation-bound candidate ref
  G->>R: recompute tree modes and delta
  G->>D: fsync + atomic rename strict receipt
  G-->>C: opaque candidate receipt
```

发布顺序是 `commit object → candidate ref → receipt`。Git ref 与 JSON receipt 不在同一个跨介质事务中，
因此合同依靠可重放状态，而不是宣称不存在中间状态：

- object 已写但 ref 未写：unreachable object，Git GC 可回收；
- ref 已写但 receipt 未写：相同 operation/base/result content 重试生成相同 commit 并补 receipt；
- receipt 已写：重启后严格重验 Git artifact 和 delta，exact retry 返回同一 receipt；
- ref 与当前 candidate 不一致：fail closed，不覆盖。

## 4. 回收协议

未被 M2.1 接受的候选只能通过同一个 owner 回收：

```text
durable discard tombstone
  → candidate ref CAS delete
  → live receipt delete
  → retain tombstone for exact retry
```

tombstone 在删除 ref 前落盘，所以崩溃后不会把“外部删 ref”误认为成功回收。它也是 operation identity 的
永久终态：同一个 operation 不能在回收后静默复用成另一份 candidate。

## 5. 失败状态与回滚

| 情况 | 结果 | 后续 |
|---|---|---|
| base/head/worktree owner 漂移 | `managed_workspace_drifted` 或 identity conflict | park；不发布 ref |
| worktree projection drift、undeclared/ignored residue | `managed_mutation_candidate_rejected` | 不读取其内容，不发布 ref |
| candidate 目标 blob 与 worker result blob 不同 | `managed_mutation_candidate_rejected` | 不发布 ref；park/quarantine |
| symlink/submodule/special mode/attributes/case collision | reject | 不发布 receipt；已生成 object 可 GC |
| 同 operation 已有不同 ref/receipt | identity conflict | fail closed |
| ref 后崩溃 | ref 保留、receipt 缺失 | exact capture 重放 |
| discard ref 后崩溃 | tombstone 保留 | exact discard 重放 |
| canonical SQLite head 未接受 candidate | 不影响 M2.1 | candidate 仍是非 canonical artifact |

## 6. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| verified/bundled Git ref CAS | 支持 | 支持 | 支持 |
| private temporary index | 支持 | 支持 | 支持 |
| symlink candidate 拒绝 | Git tree mode 验证；实测 | Git tree mode 验证；实测 | 同一 tree-mode 验证；创建 symlink fixture 可能跳过 |
| operation path identity | case-sensitive | case-sensitive | filesystem 路径比较 case-insensitive；Git path 仍严格 |
| process-crash convergence | 承诺；Linux recovery inventory | 承诺；macOS recovery inventory | 承诺；Windows recovery inventory |
| power-loss ordering | v1 不承诺 | v1 不承诺 | v1 不承诺 |

普通 `fsync`、Git ref 的平台实现和设备缓存不足以构成统一的断电证明，所以 v1 只声明进程崩溃收敛。

进程崩溃承诺由真实 child-process kill/reopen 测试约束：capture 在 ref publication 后被杀，新进程补齐同一
receipt；discard 在 ref deletion 后被杀，新进程依 tombstone 幂等完成清理；projection rotation 在保存旧目录及
发布新目录两个点被杀，新进程只收敛投影且保留外部内容。rotation intent 同时绑定旧 worktree 根目录的
device/inode identity；恢复拒绝预置 symlink/Windows junction，并且 projection owner 不再通过可替换 quarantine
子路径删除 `.git`。

旧投影与新 canonical projection 必须是两个独立的 linked worktree registration：Git owner 通过
`git worktree move` 保存旧目录，通过 candidate commit 创建新的 detached staging worktree，再把 staging 移到
canonical path。两者的 per-worktree gitdir、HEAD 与 index 不同；从 quarantine 执行 `reset`/`add` 不得改变
canonical HEAD/index 或 managed ref。quarantine GC 将来必须先由 Git owner 撤销 registration，再清理目录，不能把
locked quarantine 当普通缓存目录递归删除。统一的
`scripts/recovery-test-inventory.mjs` 拥有 recovery suite 和三平台期望数量，Linux/macOS/Windows workflow 消费
同一 inventory。嵌套目录的新增、修改与删除均以递归 `diff-tree -r` 的文件路径作为
receipt 证据，不能退化成顶层目录名。

## 7. 留给 M2.3a/M2.3b/M2.4 的边界

M2.2 单独不证明调用者提供的 expected blob 一定由某一次 Write/Edit 造成。M2.3a 必须把 T1 identity 与 durable exclusive reservation
原子绑定并把 exact changed paths 带入 accepted truth；M2.3b 在 T1 前冻结 owner-bound execution admission；
M2.4 让真实 worker 从 Git immutable base content 执行生产 transform、返回 result content/blob，再由 candidate owner 重算并核对 immutable tree，调用 M2.1 原子 bundle，并在真实 Host kill/reopen
测试中证明唯一 accepted successor。

因此本切片保持 Draft；它没有生产 consumer，也不提升当前 Desktop 的 resume 能力。
