# Managed Workspace M2 Extraction Ledger

- 新基线：`upstream/main@32e3cbbd0`
- 历史实现来源：`codex/managed-workspace-mutation-authority-m2@d9ba64697`
- 当前重建：M2.1 直接基于该主线；M2.2 只叠加 M2.1；M2.3 只叠加 M2.2，三个切片均保持 Draft 等待 M2.4
- 原则：历史分支只作为测试与实现来源；最终 diff 直接建立在已合入 M1.3 的最新主线上，不带入旧集成栈提交

## M2.1 文件归属

| 文件 | 归属不变量 | 处理 |
|---|---|---|
| `packages/core/src/workspace-version-authority.ts` | successor fact、strict decoder、causal scanner/head | 从历史提交迁移并按当前 subpath API 重建 |
| `packages/core/src/__tests__/workspace-version-authority.test.ts` | public scanner 行为 | 先迁 RED，再迁最小实现 |
| `packages/storage/src/sqlite-runtime-schema.ts` | successor projection schema | 历史 migration 11 重编号为当前 schema 13；保留 main 的 11/12 |
| `packages/storage/src/sqlite-runtime-store.ts` | T2 + successor + projection + head CAS bundle | 迁移并对齐当前 tool-ledger/continuation imports |
| `packages/storage/src/workspace-version-authority-internal.ts` | store-bound 唯一 writer capability | 迁移；不加入 public package exports |
| `packages/storage/src/__tests__/workspace-version-authority-persistence.test.ts` | atomicity、retry、rollback、corruption、migration | 迁移历史测试并补 stale CAS 与 populated 12→13 fixture |
| `packages/storage/src/__tests__/sqlite-runtime-crash.test.ts` | 真实子进程中 successor transaction 的 kill/reopen 边界 | 扩展现有 crash harness，证明 rollback 与 exact retry |
| `docs/architecture/runtime-managed-workspace-mutation-version-authority-v1.zh-CN.md` | M2.1 实现合同 | 按当前 schema、最新 main 与 PR 切片重写 |
| `docs/architecture/runtime-resume-phase3-phase4-workspace-checkpoint-design.zh-CN.md` | 总路线 | 只更新 M2 子切片，不迁入旧依赖图 |

## 明确不进入 M2.1

| 历史或未来内容 | 归属 |
|---|---|
| `managed-dependency-environment`、bundled npm、worker bridge | 已合入 main 的 M1.3 前置，不从旧 M2 分支重复携带 |
| Git candidate ref/commit、delta/path policy、orphan GC | M2.2 |
| T1 mutation profile/base freeze、owner-bound mutating admission | M2.3 |
| 真实 Write/Edit composition、Host crash/reopen | M2.4 |
| continuation boundary 绑定 workspace version | M3 |
| restore、rebaseline、publish、undo、replication | M4 |

## M2.2 增量归属

| 文件 | 主要不变量 |
|---|---|
| `packages/storage/src/managed-mutation-candidate-authority-internal.ts` | 只有 service-bound internal capability 能 capture/discard candidate |
| `packages/storage/src/git-workspace-service.ts` | 在既有 Git owner 中发布/验证 operation-bound ref、receipt 与 discard tombstone |
| `packages/storage/src/__tests__/managed-mutation-candidate-authority.test.ts` | 真实 Git capture、嵌套 add/modify/delete、receipt corruption、真实 child-process capture/discard crash convergence 与路径策略 |
| `packages/storage/src/__tests__/fixtures/git-workspace-service-crash-child.ts` | candidate ref/receipt 与 discard tombstone 的真实进程 kill seam |
| `scripts/recovery-test-inventory.mjs`、`scripts/run-recovery-test-inventory.mjs` | recovery CI 的 suite/期望数量唯一清单与跨平台执行器 |
| `.github/workflows/windows-recovery.yml` | Windows 消费统一 inventory，不维护第二份文件名/魔法计数 |
| `docs/architecture/runtime-managed-workspace-git-mutation-candidate-owner-v1.zh-CN.md` | M2.2 owner、发布顺序、失败状态和平台矩阵 |

M2.2 仍不迁入 runtime protocol、Host lifecycle、Write/Edit composition 或 SQLite successor commit；这些分别属于
M2.3/M2.4。当前 M2.2 已从最新 `main` 重建，且相对 M2.1 不重复携带 M1.3 文件。

## M2.3 增量归属

| 文件 | 主要不变量 |
|---|---|
| `packages/core/src/runtime-event.ts` | strict `managed_mutation_v1` T1 durable profile，不接受宽松路径或未知字段 |
| `packages/core/src/__tests__/runtime-event.test.ts` | profile exact-shape、ID/OID/digest/path policy |
| `packages/storage/src/managed-mutation-path-internal.ts` | M2.2 capture 与 M2.3 admission 共用的 canonical Git path policy |
| `packages/storage/src/managed-workspace-mutation-authority-internal.ts` | owner-bound one-shot lease/scope capability 和 phase machine |
| `packages/storage/src/managed-workspace-owner.ts` | 重读 canonical head、独占 admission、owner drain、scope 内 capture/discard |
| `packages/storage/src/git-workspace-service.ts` | 仅改为复用共享 path validator，不改变 M2.2 artifact owner |
| `packages/storage/src/sqlite-runtime-store.ts` | online successor writer 与 rebuild 同时要求 T1 profile 与 successor 完全匹配 |
| `packages/runtime/src/tool-runtime.ts` | Host admission hook；profile 与 T1 同写；缺 capability 时 pre-T1 fail-closed；lease 包住实现 |
| `packages/storage/src/__tests__/managed-workspace-owner.test.ts` | admission identity、并发 lease、close drain、scope one-shot、candidate capture/discard |
| `packages/storage/src/__tests__/workspace-version-authority-persistence.test.ts` | 缺少 managed T1 的 successor 被拒；online/rebuild identity 一致 |
| `packages/runtime/src/__tests__/tool-runtime-durable-boundary.test.ts` | T1/lease/impl/T2 顺序和无 admission 时禁止 fallback |
| `packages/storage/src/__tests__/fixtures/git-workspace-service-crash-child.ts`、`managed-workspace-baseline.test.ts` | admission 后、T1 前真实进程退出并由新 owner reopen |
| `packages/storage/src/__tests__/sqlite-runtime-crash.test.ts` | 带 managed T1 的 successor transaction kill/reopen |
| `scripts/recovery-test-inventory.mjs` | 将 M2.3 真实进程 admission crash 纳入统一 recovery inventory |
| `docs/architecture/runtime-managed-workspace-mutation-execution-admission-v1.zh-CN.md` | M2.3 owner、T1 边界、失败状态、回滚、平台矩阵与 M2.4 接口 |

M2.3 不修改 built-in Write/Edit，不接 Desktop/CLI，不执行真实 mutation，也不接受 successor。启用工具 marker、worker
composition、candidate capture 后的 M2.1 bundle、真实 Host crash matrix 全部属于 M2.4。

## Commit 映射

| 当前提交 | 来源 | 说明 |
|---|---|---|
| `feat(core): define causal workspace successor facts` | `d9ba64697` 的 core 片段 | 去掉已删除的 root index export，只保留 subpath contract |
| `feat(storage): atomically accept workspace successor versions` | `d9ba64697` 的 storage 片段 | 解决当前接口冲突并把 migration 顺延到 13 |
| 文档提交 | 现行工程实践 | 增加 extraction ledger、平台/失败边界和 M2.2–M2.4 切片 |

## Diff 审核门槛

最终 PR 必须同时满足：

1. 相对最新 `upstream/main` 只出现本表列出的 M2.1 文件；
2. `git range-diff` 能说明历史 `d9ba64697` 的核心逻辑去向；
3. 不包含 bundled npm、Desktop、CLI、Git candidate 或 Write/Edit production composition；
4. 最终 Draft 必须以最新 `upstream/main` 为直接祖先，并运行 schema/rebuild/crash/concurrency suites。

对 stacked M2.2/M2.3 的开发分支，上述第 4 条解释为：每一层只以上一层经过验证的 Draft head 为直接父提交；在
转为最终交付前，仍须在前置合并后从届时最新 `upstream/main` 平铺重建，长期 integration branch 不直接合并。
