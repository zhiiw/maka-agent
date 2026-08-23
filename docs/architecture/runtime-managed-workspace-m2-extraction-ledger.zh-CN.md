<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Managed Workspace M2 Extraction Ledger

- 新基线：`upstream/main@19cd9e782`
- 历史实现来源：`codex/managed-workspace-mutation-version-authority-m2-1@14327f5f0`
- 当前重建分支：`codex/m2-1-successor-authority-rebuild`
- 原则：历史分支只作为测试与实现来源；最终 diff 直接建立在最新主线上，不带入旧集成栈提交；
  M1.3 与 Gitoxide 数据面继续作为并行 Draft，不冒充本切片的已合入前置

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
| `managed-dependency-environment`、bundled npm、worker bridge | M1/M1.3 独立前置；不从旧 M2 分支重复携带 |
| Git candidate ref/commit、delta/path policy、orphan GC | M2.2 |
| T1 mutation profile/base freeze、owner-bound mutating admission | M2.3 |
| 真实 Write/Edit composition、Host crash/reopen | M2.4 |
| continuation boundary 绑定 workspace version | M3 |
| restore、rebaseline、publish、undo、replication | M4 |

## Commit 映射

| 当前重建内容 | 来源 | 说明 |
|---|---|---|
| core RED tests + causal successor facts | `14327f5f0` 的 core 最终状态 | 只保留 subpath contract |
| storage RED tests + atomic successor writer | `14327f5f0` 的 storage 最终状态 | 在 current-main schema 12 上新增 migration 13 |
| 文档与 extraction ledger | 现行工程实践 | 记录最新 main、Gitoxide 换轨和 M2.2–M2.4 等待关系 |

## Diff 审核门槛

最终 PR 必须同时满足：

1. 相对最新 `upstream/main` 只出现本表列出的 M2.1 文件；
2. `git range-diff` 能说明历史 `d9ba64697` 的核心逻辑去向；
3. 不包含 bundled npm、Desktop、CLI、Git candidate 或 Write/Edit production composition；
4. 最终 Draft 必须以最新 `upstream/main` 为直接祖先，并运行 schema/rebuild/crash/concurrency suites。
