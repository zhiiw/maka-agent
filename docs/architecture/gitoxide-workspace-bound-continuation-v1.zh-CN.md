# Gitoxide workspace-bound continuation v1

## 目标

本切片只证明一个主要不变量：

> managed-coding-v2 的 continuation 必须同时绑定不可变 RuntimeEvent 前缀与同一 SQLite 事务读取到的 accepted Git workspace head；任一侧漂移都不得继续 provider dispatch。

普通 continuation 仍使用 `continuation_claim_v1`。Managed continuation 使用
`continuation_claim_v2` 和 `continuation_source_v3`，不存在从 v2 静默降级为 v1 的路径。

## Owner 与权限

- Runtime owns：RuntimeEvent high-water、provider replay manifest、target Run identity。
- SQLite owns：workspace epoch、accepted version/head、claim/start 的原子写入与重验。
- Gitoxide helper owns：source HEAD 与 `refs/maka/accepted` 的只读复核。
- Runtime Host owns：把 SQLite observation 与 Gitoxide observation 组合成 safety observation。

Host 只能通过 `execution_stores_workspace_continuation_authority_v1` 读取 continuation
boundary。该 opaque capability 不暴露 candidate、successor、T2 或 head 推进权限。

## 绑定内容

`managed_workspace_continuation_boundary_v1` 包含：

- storage root、repository、workspace、epoch、instance identity；
- source commit/tree；
- accepted workspace version、accepted event、revision；
- accepted commit/tree；
- materialization、policy、execution profile digest。

最终 `boundaryDigest` 对 Runtime boundary 与上述 workspace boundary 一起做 canonical
SHA-256 commitment。`replayManifestDigest` 仍只表示 RuntimeEvent lineage，不能与 composite
boundary digest 混用。

## 原子性边界

1. continuation plan 从 immutable RuntimeEvents 建立 Runtime boundary；
2. SQLite 在单个 read transaction 中读取并校验 epoch/head/version/projection；
3. Host 用短生命周期 Gitoxide helper 重验 source HEAD 与 accepted ref；
4. claim transaction 再次重验 workspace boundary 后写入 claim；
5. continuation-start transaction 再次重验 workspace boundary后写入首个 RuntimeEvent；
6. 只有以上步骤完成后允许 provider dispatch。

Git 与 SQLite 不组成跨系统事务。Git observation 只作为 admission proof；accepted truth 仍是
RuntimeEvents + 可重建 workspace authority projection。

## 失败状态与恢复

- boundary 缺失、helper 缺失、source/accepted-ref 漂移：park/fail closed；
- claim 已提交但 start 未提交：使用专用 repair writer，不调用 provider；
- start 已提交而 Host 退出：标记 `continuation_started_indeterminate`，禁止 provider replay；
- provider 已被调用但响应未知：保持 indeterminate，后续显式重试也不得再次调用 provider；
- malformed claim、row/payload mismatch、projection corruption：拒绝 session continuation authority。

回滚仅删除尚未提交的事务内状态。已经持久化的 claim/start 不回滚，通过重验与专用 repair
路径收敛。

## 平台矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | SQLite claim/start crash convergence；Gitoxide source/ref 重验；Host kill 后 provider-at-most-once |
| macOS | 与 Linux 相同；路径先 realpath canonicalize |
| Windows | 与 Linux 相同；进程终止证据由专用 Gitoxide workflow 执行 |

三平台共用 `.github/workflows/gitoxide-helper-admission.yml` 中的真实 helper/Host crash test。
没有系统 Git 或 PATH fallback。

## 产品范围

该能力只对 canonical `managed-coding-v2` 生效。普通会话行为不变。Desktop 新任务 Composer 已提供显式
`Managed workspace` 产品意图；renderer 不能直接签发 profile，Desktop main 在 Session 创建前把该意图
映射为 immutable `managed-coding-v2`。Catalog 会把 profile 投影回 Desktop，已有 Session 只显示状态、
不能切换。Managed Run 与手动 Resume 不依赖普通 Session 使用的实验开关，但所有 safety observation 仍需
fail closed。Accepted-tree Read/Glob/Grep 尚未接入，因此这只关闭产品入口，不代表完整 M3 已完成。
