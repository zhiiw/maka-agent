# Managed workspace lifecycle crash matrix v1

## 1. 主要不变量

> accepted workspace 的交付与恢复动作一旦到达各自 durable publication point，即使 owner process 在返回响应前
> 退出，使用同一 operation identity 重试也只能收敛到同一个结果；不得重写 accepted history、覆盖 source
> checkout 或签发第二个冲突 artifact。

本矩阵覆盖 Desktop Review 面板背后的 M4 v1 生命周期动作：

- immutable accepted-ref Publish；
- source-branch Publish；
- isolated Restore；
- historical Undo-as-successor；
- Rebaseline/new epoch activation；
- restore-orphan maintenance。

## 2. Owner、publication point 与恢复

| 动作 | Owner | Durable publication point | 响应丢失后的恢复 |
| --- | --- | --- | --- |
| accepted-ref Publish | Gitoxide publish owner | `refs/maka/published/<id>` CAS | 同 ref/commit 返回 replay；其他目标 conflict |
| source-branch Publish | Gitoxide source publish owner | `refs/heads/maka/<id>` CAS | 确定性 commit + exact ref replay；不触碰 checkout |
| isolated Restore | restore owner | destination rename + receipt | 同 ID 保留旧 projection 为 orphan，再从 exact accepted tree 收敛 |
| Undo | history-successor owner + SQLite | successor/head transaction | 采用既有 successor，再幂等 promote accepted ref |
| Rebaseline | active-epoch authority + SQLite | active epoch transaction | reopen 已激活 epoch；旧 epoch immutable |
| maintenance | GC owner | orphan -> `.gc-*` tombstone rename | 新进程只删除 tombstone，不重新选择删除对象 |

RuntimeEvents/SQLite accepted head 仍是 accepted truth。Publish/Restore artifact 与 Git refs 是可重验的交付证据，
不是第二个 workspace head authority。

## 3. 失败状态

- publication point 之前失败：没有可见结果，使用同一有界 ID 重试；最多留下不可达 content-addressed object 或
  staging artifact；
- publication point 之后响应丢失：采用精确 durable evidence，不重新执行 accepted mutation；
- durable target 已存在但 identity 不同：fail closed/park，不覆盖；
- restore projection 被外部修改：完整目录进入 Maka-owned orphan，用户字节不被静默删除；
- Windows 文件占用阻止 tombstone 删除：保留 tombstone 到下一次 maintenance。

这些动作不支持“换一个 ID 继续”作为自动恢复；operation identity 是 durable contract 的一部分。

## 4. Production-shaped 证据

真实 child process 使用 production session owner 和真实短生命周期 Gitoxide helper完成 durable 动作后立即退出，
不向调用者返回结果。新进程重新取得 storage-root owner，open 同一 managed Session，并使用同一 ID 重试：

1. accepted ref 仍指向同一 accepted commit；
2. source branch 仍指向同一 deterministic published commit；
3. Restore 仍物化同一 accepted tree；
4. Undo、Rebaseline 与 maintenance 使用各自已有的 commit/activation/tombstone failpoint 进程测试。

该矩阵证明 process-crash convergence，不声明硬件断电持久性。

## 5. 平台矩阵

Linux、macOS、Windows 运行相同 real-helper session-owner suite。差异仅在文件删除：Windows 的 open-handle 失败
保留 tombstone；POSIX 仍必须验证目录不是 symlink。任何平台的 source checkout、HEAD 和 index 都不由该矩阵
修改。

## 6. 非目标

- 不实现直接覆盖用户 checkout 的 Apply；M4 v1 通过新 source branch 安全交付；
- 不删除 published/history refs；它们是显式 retention roots；
- 不在 Node 层自行实现 Git object reachability GC。候选 ref/receipt 与 object compaction 需要独立、root-aware
  Gitoxide owner，未完成前保守保留空间而不是冒险删除。
