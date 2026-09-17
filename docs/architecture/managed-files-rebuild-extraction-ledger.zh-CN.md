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

# Managed files 重建提取账本

## 当前检查点（2026-09-17）

- 新基线：`upstream/main@672d82731`。
- 新分支：`codex/managed-files-mainline-rebuild`。
- 旧上游 #4265 已关闭；来源快照 `70053087a` 保留，不重放旧 Runtime 大块 diff。
- 产品决定：显式 managed 文件任务位于 Desktop 加号菜单，与 Plan、Swarm 同级；当前尚未实现入口。
- 当前只是重建过程中的可验证检查点，不是独立发布 PR。纯转换暂为 package-private 模块，无 package export、无 Runtime dispatch 接线。

## 第一步裁定：不另造 Storage bridge PR

当前 `execution-stores.ts` 已通过统一 `run()` 包装实施 lease 校验、在途调用跟踪与 close/drain。`execution-provider-conformance.test.ts` 已覆盖 Local/Memory 后端的撤权和关闭协议。

旧 `execution-stores-workspace-authority-internal.ts` 主要是未来 Host 的桥接，不是现有调用路径的独立修复。直接复制会绕过当前 provider/lifecycle owner。故暂不恢复该模块、不公开其 package export，不为了“两个 PR”增加无消费者的生命周期包装。

后续真实消费者需要 workspace authority 时，必须在当前一致性域内接线，并补关闭期间结算、跨 store/root、投影丢失时 root adoption 等测试。此次没有改变数据库，也没有证明未来 bridge 的正确性。

## 旧 #4265 commit 处置

| 来源 commit | 原职责 | 本轮处置 |
| --- | --- | --- |
| `172cf997e` | Runtime 参数权限与清理测试 | 原测试依赖已删除 admission API；保留断言意图，待新接线重写，不整体移植 |
| `5046af17d` | accepted-content 纯转换及 Runtime 接线 | 仅提取纯算法与其直接测试；Runtime 接线不提取 |
| `7ddbdf13a` | settlement proof 与 Storage bridge | 延后，与当前 provider/Host owner 一起重建 |
| `ddec25e5d` | 去除第二套 terminal result 权限 | 作为单一 Runtime result 的设计约束，不恢复旧 union |
| `a6bf8f346` | owner/store/root 和 terminal 修正 | 对照当前主线重审，不能跳过现有 lease/drain |
| `2d579a5ec` | 文档 ASF header | 新文件保留 ASF header；旧已实施合同不直接宣称仍适用 |
| `70053087a` | 删除无消费者 package export | 新基线未添加该 export，无需重放补丁 |

此表覆盖旧 #4265 七个提交。#43 及其后 fork 分支尚未逐 commit 提取，不能将本表称为整个 M3–M5 栈完成清点。

## 文件与测试处置

| 文件/测试 | 处置与原因 |
| --- | --- |
| `packages/runtime/src/managed-mutation-transform.ts` | 从旧快照手工提取；保留纯计算、原参数绑定、冻结结果。Edit 改用当前主线 `createEditUnifiedDiff`，删除无消费者 rejection-message 常量 |
| `packages/runtime/src/__tests__/managed-mutation-transform.test.ts` | 原 3 个直接测试保留；新增 6 个大文件局部 diff、空文件/no-op、新行变更、路径绑定、别名隔离与 Edit 失败语义测试 |
| `packages/runtime/src/tool-runtime.ts` | 完全不改；后续接线必须保留主线 model projection、统一发布和权限判断 |
| `packages/runtime/src/__tests__/tool-runtime-durable-boundary.test.ts` | 完全不改；运行主线测试作为回归基线，不恢复被 #5287 删除的约千行专用测试 |
| `packages/storage/src/execution-stores.ts` | 完全不改；当前生命周期是后续接线约束 |
| `packages/storage/src/execution-stores-workspace-authority-internal.ts` | 不移植；待真实消费者确定受限接口 |
| 同名 Storage authority test | 不移植；旧 fake API 不能证明新 provider/lease 生命周期 |
| `packages/storage/src/workspace-version-authority-internal.ts` | 完全不改；现有私有 SQLite authority 继续保留 |
| `packages/storage/src/sqlite-runtime-store.ts` | 完全不改；不引入旧 root-adoption 路径 |
| `workspace-version-authority-persistence.test.ts` | 运行现有测试，不为移植重写预期 |
| 两份旧 pure-transform / settlement-proof 文档 | 作为历史设计来源，不复制其中已经失效的接线/平台完成声明 |
| `managed-resume-mainline-rebuild-plan-2026-09.zh-CN.md` | 收录经用户确认的执行方案及显式入口决定 |

没有 cherry-pick 整个跨边界 commit。只有两个 Runtime 源文件来自选定快照，因此不以 commit range-diff 完全相等作为证据；核对文件 diff 和迁移测试。

## 纯转换的范围

输入是已验证的 canonical path、accepted text 和 Runtime 参数；输出是内容、是否改变和 provider result。它不访问磁盘、Git、网络或进程。

路径 policy、Git blob 校验、输入体积 admission、strict-JSON terminal snapshot、model projection、T1/T2 原子性和恢复均仍由后续完整链路负责。这一函数本身不证明安全恢复或任意未知输入的资源上限。

Write 的成功 no-op 和 Edit 的参数错误保持区分：相同 Write 内容可以 `changed=false`；`old_string === new_string` 遵循当前生产 Edit matcher 的拒绝语义。

## 已执行的验证

环境：Windows，Node 24.18.1，以上新基线；不代表 macOS/Linux 已验证。

1. Core、Storage、MCP、Runtime build：通过。
2. 原始 transform 三个测试：迁移后 3/3，通过。
3. 新增“大文件小 Edit 保留局部 diff”：旧实现 RED（没有 file_diff），改为主线局部 diff 后 GREEN。
4. transform + Edit matcher 定向测试：28/28，通过，其中 transform 9 项。
5. 主线 Runtime durable boundary + Storage workspace persistence：52/52，通过。
6. Execution provider Local/Memory close/drain/revocation 定向：6/6，通过。

共 86 个测试通过，无跳过。没有运行真实 Host/helper crash、Electron、全量测试或平台 CI；不宣称 Resume 已能使用。

## 下一检查点

先确定当前 ExecutionPersistence 与 workspace owner 的真实接线，再完成一条 Write 纵向路径；不得先把旧 Runtime 接口整套恢复后期待 Host 去适配。随后接 Edit/accepted reads 和真实 crash 测试，再加入 Desktop 加号入口。

Windows 的 file-only profile 不依赖 Bash/npm command sandbox；启用前仍必须得到真实 Windows Host/helper 恢复证据。
