# Managed Workspace M2 Extraction Ledger

- 新基线：`codex/managed-dependency-production-composition@f037b7018`
- 历史实现来源：`codex/managed-workspace-mutation-authority-m2@d9ba64697`
- 当前重建分支：`codex/managed-workspace-mutation-version-authority-m2-1`
- 原则：历史分支只作为测试与实现来源，不整体 cherry-pick，不带入旧 M1.3 集成提交

## M2.1 文件归属

| 文件 | 归属不变量 | 处理 |
|---|---|---|
| `packages/core/src/workspace-version-authority.ts` | successor fact、strict decoder、causal scanner/head | 从历史提交迁移并按当前 subpath API 重建 |
| `packages/core/src/__tests__/workspace-version-authority.test.ts` | public scanner 行为 | 先迁 RED，再迁最小实现 |
| `packages/storage/src/sqlite-runtime-schema.ts` | successor projection schema | 历史 migration 11 重编号为当前 schema 13；保留 main 的 11/12 |
| `packages/storage/src/sqlite-runtime-store.ts` | T2 + successor + projection + head CAS bundle | 迁移并对齐当前 tool-ledger/continuation imports |
| `packages/storage/src/workspace-version-authority-internal.ts` | store-bound 唯一 writer capability | 迁移；不加入 public package exports |
| `packages/storage/src/__tests__/workspace-version-authority-persistence.test.ts` | atomicity、retry、rollback、corruption、migration | 迁移历史测试并补 stale CAS 与 populated 12→13 fixture |
| `docs/architecture/runtime-managed-workspace-mutation-version-authority-v1.zh-CN.md` | M2.1 实现合同 | 按当前 schema、M1.3 栈和 PR 切片重写 |
| `docs/architecture/runtime-resume-phase3-phase4-workspace-checkpoint-design.zh-CN.md` | 总路线 | 只更新 M2 子切片，不迁入旧依赖图 |

## 明确不进入 M2.1

| 历史或未来内容 | 归属 |
|---|---|
| `managed-dependency-environment`、bundled npm、worker bridge | M1.3 前置，直接继承当前栈顶，不从旧 M2 commit 重带 |
| Git candidate ref/commit、delta/path policy、orphan GC | M2.2 |
| T1 mutation profile/base freeze、owner-bound mutating admission | M2.3 |
| 真实 Write/Edit composition、Host crash/reopen | M2.4 |
| continuation boundary 绑定 workspace version | M3 |
| restore、rebaseline、publish、undo、replication | M4 |

## Commit 映射

| 当前提交 | 来源 | 说明 |
|---|---|---|
| `feat(core): define causal workspace successor facts` | `d9ba64697` 的 core 片段 | 去掉已删除的 root index export，只保留 subpath contract |
| `feat(storage): atomically accept workspace successor versions` | `d9ba64697` 的 storage 片段 | 解决当前接口冲突并把 migration 顺延到 13 |
| 文档提交 | 现行工程实践 | 增加 extraction ledger、平台/失败边界和 M2.2–M2.4 切片 |

## Diff 审核门槛

最终 PR 必须同时满足：

1. 相对 M1.3 栈顶只出现本表列出的 M2.1 文件；
2. `git range-diff` 能说明历史 `d9ba64697` 的核心逻辑去向；
3. 不包含 bundled npm、Desktop、CLI、Git candidate 或 Write/Edit production composition；
4. M1.3 合并后从最新 `upstream/main` 重建，再运行 schema/rebuild/crash/concurrency suites。
