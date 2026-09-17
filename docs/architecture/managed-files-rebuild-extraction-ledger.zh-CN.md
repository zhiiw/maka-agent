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

后续真实消费者需要 workspace authority 时，必须在当前一致性域内接线，并补关闭期间结算、跨 store/root 等测试。本轮已在 Storage 私有边界重建显式 root adoption（见下文），但尚未公开 bridge；没有修改 schema，也没有证明未来 bridge 的正确性。

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
| `packages/storage/src/execution-stores.ts` | 注册内部 workspace 窄接口；所有调用复用当前 `run()`，不另建 lifetime owner |
| `packages/storage/src/execution-stores-workspace-authority-internal.ts` | 不移植；待真实消费者确定受限接口 |
| 同名 Storage authority test | 不移植；旧 fake API 不能证明新 provider/lease 生命周期 |
| `packages/storage/src/workspace-version-authority-internal.ts` | 新增显式、package-private 的 non-workspace state adoption；保留严格 binder 默认行为 |
| `packages/storage/src/sqlite-runtime-store.ts` | 不复制旧 projection-only adoption；在同一事务内扫描 immutable ledger、核对投影并绑定 root |
| `workspace-version-authority-persistence.test.ts` | 保留原 30 项；新增普通历史接管、四类 workspace residue 拒绝和两项真实子进程退出验证 |
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

## 第二检查点：已有普通聊天数据库的显式接管

问题：当前严格 binder 拒绝任何已存在的 operational state；新入口不能因此要求用户删除普通聊天数据库。

- **Owner**：Storage 内部 workspace authority。未来由持有真实 root lease 的 execution composition 显式调用；当前没有公共 export 或自动启动接管。
- **原子边界**：既有 SQLite write transaction 内，读取 root binding、扫描 canonical workspace ledger、检查投影、插入 binding。没有新 schema/version。
- **允许状态**：尚无 workspace authority 的普通数据库。普通 RuntimeEvent 原样保留；绑定后重开仍只接受同一 root。
- **拒绝状态**：不同 root、完整 workspace ledger、投影被删除后的 ledger、孤立投影或残缺 workspace event。不能以“投影为空”冒充“从未存在 workspace authority”。
- **失败与回滚**：检查失败不插入 binding；事务前半段进程退出后仍未绑定；提交后进程退出则保留 binding，精确重试可继续。
- **撤回本轮代码**：普通聊天路径未变。已显式写入的 binding 使用现有 schema 和格式，不通过删库/删 evidence 回滚。

验证：普通历史接管先 RED（原严格 binder 拒绝），实现后 GREEN。Storage persistence 共 37 项通过，其中两项是真实 Node 子进程不关闭数据库直接退出，再独立 reopen；它们不是完整 Host/helper kill test，也不证明断电持久性。

| 平台 | 当前证据 |
| --- | --- |
| Windows | 本地真实 SQLite、进程退出前/后 binding、重开和拒绝残缺 authority 已通过 |
| Linux | 相同测试可运行；本检查点未实跑，不宣称平台完成 |
| macOS | 相同测试可运行；本检查点未实跑，不宣称平台完成 |

尚未完成：ExecutionPersistence 的受限 workspace facade、其 close/drain 接线、Gitoxide candidate 消费者、Runtime settlement、Desktop 加号入口。此检查点只是这些接线的数据库前置，不能宣称 Write/Edit Resume 已可用。

## 第三检查点：workspace authority 进入 execution group 生命周期

第二检查点所列 facade/close/drain 接线已完成；Gitoxide/Runtime/产品接线仍未完成。

- **Owner**：现有 `InteractiveExecutionStoresWriter` 的 root lease 和 `run()`。新增 `execution-workspace-authority-internal.ts` 只按真实 stores 对象登记 capability，没有自己的数据库或 close owner；目前不新增 package export。
- **窄接口**：验证后提交 baseline/successor/no-effect，读取 canonical head/reservation。调用方拿不到 SQL、原始 store、root 重绑定或单独关闭权限。
- **proof owner**：每个 execution group 只选定一个 trusted composition verifier 对象；并发打开返回同一 facade，替换 owner 被拒绝。捕获 verifier 方法，后续替换对象上的方法不会改写已选定的方法。它不是针对任意恶意同进程代码的隔离沙箱，实际 Gitoxide verifier 尚待 Host 接入。
- **一致性域**：Local provider 懒加载使用现有 runtime store，同一 rootId，不建立旁路连接。Memory/其他没有该域的 provider 明确拒绝，不 fallback 到 SQLite；普通聊天仍可使用。
- **关闭/失败**：open/read/commit 都计入同一在途调用集合；close 先撤权，再 drain，再关数据库。root owner 被撤销时 retained facade 也失效。打开失败保留失败 promise，不在同一 group 上重试未知状态或更换 verifier。
- **原子边界**：底层仍为已有 SQLite baseline / successor+T2 / no-effect+T2 事务，本轮没有改变事实格式和数据库版本。
- **回滚**：取消 workspace 组合入口即可停止新调用；不删除既有 binding、RuntimeEvent、head 或 reservation。普通 session/T1/T2 路径未改变。

新增 6 项真实 provider 合同测试：窄接口/关闭、固定 proof owner 与 baseline reopen、不支持的 provider 与伪造 group、close drain、root 撤权、uncertain open。首项先 RED（Local 未提供该域）再 GREEN。provider 合同全集 93 项，加 Storage persistence、Runtime durable boundary 和纯转换，共 161 项通过、无跳过；Storage/Runtime build、Biome 和 diff check 通过。

平台证据仍仅为本机 Windows；没有宣称 Linux/macOS、完整 Host/helper crash 或 Desktop 验收完成。下一步才是 Host Gitoxide proof owner 消费这一窄接口，并接一次真实 Write 的 terminal settlement。

## 第四检查点：真实 Gitoxide import proof 接入 SQLite baseline

Host 新增 `gitoxide-workspace-baseline-owner-internal.ts`，使用现有 execution-stores 子路径上的受限接口，没有导出原始 SQLite writer。每个 execution group 一个 baseline proof owner；多 workspace 共用该 owner，不能由每个 session 另换 verifier。

acceptImport 只消费 owner-bound repository capability。Gitoxide admission 模块保留 helper 实际返回的 immutable import observation，由 WeakMap 验证 owner 后读取；不接受调用者重新提交的 commit/tree/count 描述。baseline 的 source/commit/tree/count 来自该 observation，事件 ID 与 workspace key 确定，时间戳固定为 0 作为确定性 import 事实（不冒充实际执行时间）。相同 epoch 的不同 import 由 SQLite exact-retry 检查拒绝。

真实测试完成：helper import → baseline commit → 同 proof 精确重试 → SQLite group 关闭/重开 → 原 capability 重试；错误 owner、伪造 capability、source 更新后替换同一 epoch 均拒绝。Gitoxide admission 9/9，无跳过，Windows 本机执行。此测试没有启动 Desktop 或完整 Runtime Host 服务。

### 新确认的恢复前置缺口

主线 import 只允许 fresh destination。真实第二次 import 报 `import_destination_not_fresh`，不能重新取得已导入 repository 的 capability。测试明确保留这一拒绝，并只将 retained capability 下的 SQLite reopen 标为通过，**不称为跨进程恢复通过**。

下一步必须增加有独立证据的 managed repository reopen owner：验证目标目录归属、helper/policy、Git graph 与 SQLite accepted identity，再重新发行进程内 capability；不能删除目标目录、重复 import 或信任磁盘旁边的自报描述。随后再接 candidate settlement 和 accepted-ref reconciliation。当前 helper 也未开放 accepted-ref 推进，不能通过调用 Git CLI 绕过该缺口。

本轮不接启动流程、不开工具、不启用 Desktop；successor/no-effect verifier 显式不可用。Git/SQLite 两存储间不是原子事务：import 完成、baseline 未提交的孤立 artifact 恢复仍是下轮 gate。仓库目录规划、source admission 以及跨进程恢复生命周期尚未接入产品，因此这是重建检查点，不是 Resume 可交付状态。

### 本机 helper 验证环境

复用已有 `C:/Users/wzy/.local/llvm-mingw-20260616/llvm-mingw-20260616-ucrt-x86_64/bin`，仅加入构建进程 PATH。Rust 使用 `1.98.0-x86_64-pc-windows-gnullvm`，linker 为 `x86_64-w64-mingw32-clang`，最终 binary 使用 `cargo rustc --locked --manifest-path native/gitoxide-helper/Cargo.toml --bin maka-gitoxide-helper -- -C target-feature=+crt-static`。

默认 MSVC 缺少 link.exe；普通 GNU LLVM 构建又依赖 libunwind.dll，受限 helper 的空 PATH 下无法启动。静态 runtime 构建后依赖表不再含 libunwind.dll，同一真实调用测试由 1/8 改为 8/8，通过后本轮增加 baseline 集成为 9/9。该二进制仅是本地测试产物，不是签名发布产物；不改变正式平台发布配置。

## 第五检查点：已接受 repository 的只读 reopen

第四检查点发现的“进程重启丢失 capability”已增加专用恢复入口，不修改 fresh import 规则。

### 合同与 owner

- Host baseline owner 从当前 execution group 读取 canonical epoch/head；workspace key、repository path 派生 identity、SHA-1、policy 和 helper artifact profile 必须匹配。调用者不能提供另一个 commit/tree 覆盖 SQLite 事实。
- 新 `reopen_repository` helper operation 只读。拒绝非 bare 目录、symlink/junction 与不可信父路径，沿用 metadata admission budget，再验证 commit/tree 哈希、完整 bounded tree/blob graph、policy v3 和直接的 `refs/maka/accepted`。遍历后重新检查 ref。
- Host helper response 必须严格匹配请求，且 artifact 必须 attested 支持 reopen。helper 返回后再次读取 Storage head 并检查取消；group 撤权或 head 改变时不向调用者交付 capability。
- 新 capability 属于新 owner，可供 accepted read / candidate creation 使用；它不是 import provenance，不能拿来伪装成首次 import proof 再提交 baseline。
- 不写新 receipt、不增加 schema、不移动 ref、不改文件内容，也不需要重新访问 source checkout。权威仍是 SQLite accepted identity + 重新验证的 Git objects，不是进程内 WeakMap 的旧记录。

### 失败、回滚与范围

任何 identity/graph/ref/policy 不匹配都拒绝，不删除/重导入/自动修复。helper 二进制变化导致 profile 不同也拒绝，未为旧 Draft artifact 增加兼容层。撤回入口仅停止发行新 capability，不修改既有事实。

本轮只恢复**已经有 SQLite accepted baseline/head 且 Git ref 一致**的 repository。import 已完成但 baseline 尚未提交、缺失/corrupt Git object、SQLite 已接受但 Git ref 尚未推进的情况仍需后续 owner 处理；不因本轮增加 reopen 就声称所有 crash 点可收敛。

### 实证与平台

先运行真实 helper 得到 RED：`reopen_repository` 为 `invalid_request`；新增 Rust 操作后 GREEN。真实进程测试使用第一 Node 进程执行 import + SQLite baseline 并 `process.exit(77)`，跳过 Store/lease cleanup；第二 Node 进程重新取得 root lock、重新 admission helper、从 SQLite 读 identity、发行新 capability 并读取相同 accepted 内容；第三次重开结果相同。符号 accepted ref 和删除深层 blob 后重开均拒绝，ref 未被恢复逻辑修改。

这是真实 Host owner + Storage + helper 边界的进程退出测试，不是完整 Desktop/模型/Write T1/T2 场景，也不证明断电。

| 平台 | 本轮证据 |
| --- | --- |
| Windows | 本机进程退出/新进程 reopen、ref/blob 拒绝测试通过；native junction 用例纳入 Rust suite |
| Linux | 现有三平台 Gitoxide workflow 会执行同一 fixture；尚无本轮远程结果 |
| macOS | 同上，不以 Windows 结果替代 macOS 证明 |

workflow 选择范围已纳入新 Host owner、child fixture 与 Storage 变更，避免只改接线时漏跑恢复测试。下一步仍是 candidate → Runtime terminal → SQLite acceptance → accepted-ref reconciliation；Desktop 加号入口尚未启用。

本轮验证记录：Rust 14 个 unit + 55 个 integration 全通过；三组 Host helper 定向测试 27 通过、5 个既有 Windows 条件跳过，新跨进程 reopen 用例实际通过；Storage provider/persistence 定向测试 93/93；Gitoxide workflow policy 定向测试 1/1；Storage、Runtime Host build 与改动 TypeScript 的 Biome check 通过。完整 workflow-policy suite 另有 Windows Bash 路径失败（`shared comparison drives every diff gate on refreshed merges, pushes and dispatches`），不将该 suite 宣称为全绿，也不在本次修改无关脚本。

## 第六检查点：candidate 发布后退出的恢复前置证据

在连接 terminal writer 前，新增真实进程测试证明 candidate 与 accepted truth 没有混淆：

1. 进程 A import 并提交 SQLite baseline，直接退出，不执行关闭清理。
2. 进程 B 经 SQLite identity reopen，调用真实 helper 发布 operation-bound candidate，输出 owner 验证后的证明，再以 78 退出，不执行关闭清理。
3. 进程 C 重新获得 root ownership 和 repository capability，用相同 operation/path/content 重验 candidate；新进程发行的证明与原证明完全一致。
4. 同一 operation 改为另一内容时明确拒绝 `candidate_request_conflict`；candidate ref 不被替换。
5. 再次从 SQLite reopen 的 accepted commit/tree/content 与最初完全一致；独立 Git fixture oracle 读取 candidate 内容，确认它包含新内容、但尚不是 accepted truth。

**Owner 与原子边界**：Gitoxide owner 负责 immutable candidate/ref 及 exact-request retry；SQLite 仍独占 accepted truth。两者不是一个原子事务，本测试没有越权推进 accepted ref。**失败与回滚**：冲突拒绝并保留 candidate，不删除 accepted 数据；撤回这组测试不改变生产行为。

这是测试性检查点，复用已有 helper 协议，不增加 production API、schema 或第二份 receipt。重试的是 immutable candidate construction/verification，不是重新执行 Write/Edit。尚未提交 managed T1/reservation，没有运行 Runtime settlement，不能据此声称完整 mutation crash recovery 已完成，也不覆盖 helper 在写对象/ref 内部被 kill 或断电。

本机 Windows：Runtime Host build 通过；真实 helper admission suite **11/11、0 skip**，Biome 与 diff check 通过。Linux/macOS：既有三平台 workflow 已包含此 suite/fixture，当前尚未取得本轮远程执行证据。

下一步接线仍需一次闭合：从 durable T1 reservation 取得 operation/base/path/profile，绑定 Runtime-owned 纯转换结果与 helper candidate proof，构造 successor 并原子提交 T2；no-change/failed-no-effect 必须使用各自终态。之后独立完成 accepted-ref reconciliation，再开放 Desktop。不能提前把裸 candidate capability 当作足够的 terminal authority。

## 第七检查点：已发布 candidate 的成功 settlement

本轮实际接通 Host proof owner → execution-group authority → SQLite successor/T2，不再仅是 candidate 测试。新 `acceptPublishedCandidate` 不接受 successor descriptor；与 baseline 共用每个 execution group 唯一的 verifier owner。

主要不变量：**只有与 durable T1 的操作及精确内容相符的 candidate，才能和成功 T2 一起被接受。**

- candidate 必须为真实 helper 发行且绑定正确 repository/owner 的 published capability；no-change capability 不能进入此入口。
- Host 从 canonical epoch 和有界 RuntimeEvent 读取（16,384 条 / 32 MiB）取得唯一 T1、原始 Write/Edit 参数及 base/path/profile；repository、helper artifact profile、policy、workspace instance 均须匹配。读取超限明确拒绝，不以较弱证据 fallback。
- 从 accepted Git tree 读取原文件，用现有纯转换重算结果；同时比较 result content SHA-256 与 Git blob OID，阻止相同路径不同内容进入 successor。工具结果以 Runtime 的 durable ToolResultContent 表示进行精确比较，不信任 caller 提供的成功描述。
- outcome 在第一次 await 前经 canonical RuntimeEvent 编码断开可变引用；successor 字段由验证过的事实生成，私有 proof 仅在当前 owner 的 WeakMap 内传给 SQLite。调用者不能自行提供 commit/tree/version/profile 替换它们。
- **原子边界**仍是已有 SQLite transaction：T2、successor fact、version/head projection 和 reservation 释放全成或全败。head CAS、T1 reservation 和 exact retry 由 Storage 再验证；本轮没有新增 schema 或第二事实源。
- **失败状态**：证明缺失、内容不符、错误 owner、结果不符、Store 关闭或事务失败都拒绝；不补 generic T2、不删除 reservation。**回滚**：停止组合该内部入口，保留已写 immutable facts，不降级/改写历史。

### 证据及未完成范围

真实 helper + execution group integration 从未接通入口的 RED 开始，补实现后 GREEN。覆盖成功接受、精确重试、伪造 owner/结果拒绝、错误内容拒绝，以及 SQLite 接受后真实子进程 `exit(79)` 不清理再由新进程读取。新进程确认唯一 T2/successor 和无 active operation；accepted Git ref 仍保持原 base，reopen 对该 stale ref 明确拒绝。这不是“ref 已恢复”的证据。

本轮尚未接 ToolRuntime 的 managed execution/adoption、Desktop 或完整 Host 服务。测试中的 T1/T2 由 fixture 通过真实存储 API 构造，不宣称模型/工具生产闭环。

当前入口仅能证明 **已有 UTF-8 文件的成功变更**。新建路径不能把 `tree_file_unavailable` 当作“文件不存在”：该错误也可能表示缺对象，需先增加 helper 的显式 absence proof。no-op 与 failed-no-effect verifier 仍关闭。没有支持 Delete、Bash/npm，没有放宽权限，也没有重新执行文件系统副作用。

| 平台 | 本轮证据 |
| --- | --- |
| Windows | 本机真实 helper/进程退出 integration 14/14；Storage authority + pure transform 46/46；Host build、Biome、Gitoxide workflow policy 通过 |
| Linux | 已有 workflow 执行相同 suite，新 settlement/transform 变更也触发 gate；尚无本轮远程结果 |
| macOS | 同 Linux，不以本机 Windows 测试替代平台验证 |

下一步：显式 absent-file proof 与 no-effect terminal；accepted-ref reconciliation；随后连接 Runtime 的单次 operation/result authority 并补完整 Host crash test。完成这些之前不开放 Desktop managed 文件执行。

## 第八检查点：新文件的明确 absence proof

第七检查点的新文件限制现已补齐：`read_tree_file` 增加显式、可选的 `allowMissing: true` 请求。默认 Read 合同不变；只有 opt-in 请求才允许得到 `tree_file_absent` 成功响应，绑定 protocol、policy、accepted commit/tree 和 canonical path。它不包含伪造的空文件内容或 blob OID。

- **Owner**：Rust helper 验证 commit 与每层 tree 对象哈希，完整解析当前 tree 后，才能声明缺少对应 entry；Host 严格验证 response keys 及 request identity，repository capability owner 再核对 accepted tree。
- 缺失 tree、缺失 blob、解析失败、父路径实际是普通文件均仍为错误，不转换为 absence。原有 strict Read 对不存在路径继续报错。
- settlement 只把明确的 absence proof 转为纯转换的 `baseContent: null`；Write 可据此新建多级路径，Edit 的缺失目标仍由纯转换拒绝。不扩大文件系统写权限，不读取用户 checkout。
- **原子性**：absence lookup 完全只读；成功变更仍沿已有 candidate → SQLite successor/T2/reservation transaction。没有新数据库表、receipt 或协议版本迁移。
- **失败/回滚**：旧 helper 不认识新请求字段时会拒绝，没有 fallback；缺对象或结果不符时保留 T1 reservation，不发布成功。撤回本次接线会停止新文件接受，不删除既有 accepted facts。

真实 Rust 测试先 RED（`invalid_request`）再 GREEN，涵盖明确 absence、strict Read、缺 tree、缺 blob 和文件型父路径。真实 Host owner fixture 覆盖新文件 candidate/原子接受/精确重试，以及成功提交后 `exit(79)`、新进程检查唯一 T2/successor/无 unsettled operation；独立 Git oracle 核对新路径内容。仍没有启动完整 Host 服务或 Desktop，也未完成 stale accepted-ref 的修复。

本机 Windows 验证：Rust **14 unit + 57 integration = 71/71**；Node helper invocation + repository admission **29 pass / 6 skip / 0 fail**，新文件/崩溃用例实际执行。6 个 skip 为 POSIX fake-helper fixture（含新 absence response correlation），不是恢复成功证据。Linux/macOS 使用现有三平台 gate，尚无本轮远程结果。下一步为 no-effect terminal 与 accepted-ref reconciliation。

## 第九检查点：成功 no-op 的独立终态

新增内部 `acceptUnchangedCandidate`，仅接受真实 helper 的 `no_change` capability；`acceptPublishedCandidate` 仍只接受 `published`。两入口共享同一 T1/epoch/helper/path/content/result 校验，不复制第二套验证规则；内部验证输出为显式 tagged union，不能按某字段是否存在选择 writer。

主要不变量：**成功无变化只提交一次 `no_workspace_change` T2 并释放 reservation，不产生 accepted successor、不推进 workspace head/ref。**

- Host owner 由 durable T1 参数和 accepted content 重算纯转换，必须 `changed === false`，精确 result digest/blob 及 candidate tree 均匹配 base。仅有 helper 的 no-change 标签不够；应产生变更的 T1 配上 unchanged candidate 也会拒绝。
- helper 现有协议会保留 operation-bound candidate commit/ref 作为 exact-retry 证据；其 commit 元数据可以不同，但 tree 必须与 base 相同。该 candidate 不获得 accepted authority。本轮不引入清理行为。
- outcome 必须为成功且精确匹配规范工具结果。Storage 还要求 `managedMutationTerminal` 与私有 no-change proof 的 operation/dispatch/instance/kind 一致；缺少 terminal fact 或错误成功状态拒绝。
- **Owner**：仍为 execution group 的同一个 Host proof owner；no-effect proof 只在其 WeakMap 内传递。**原子边界**：复用 SQLite terminal/T2 + reservation release transaction，exact retry 不重复写入。无 schema 变更。
- **失败/回滚**：错 owner、错 disposition、假 no-change、错结果、缺 terminal 均拒绝，reservation 留存；不自动 generic T2。撤销入口不会改写历史。`operation_failed_no_effect` 尚未接通，不能用任意异常冒充“已证明无副作用”。

真实 helper + SQLite 测试先得到“入口未接通”的 RED，再实现 GREEN。覆盖成功 no-op、exact retry、提交后直接 `exit(79)`、新进程看到唯一成功 T2/零 successor/无 unsettled operation，并可正常 reopen 原 head/content；也覆盖假 no-change 不释放 reservation、两个 settlement 入口不可互换。

Windows 本机：repository admission integration **19/19、0 skip**，Storage authority/纯转换 **46/46**，Host build、Biome、diff check 通过。Linux/macOS 已由同一既有三平台 workflow 选择，尚无本轮远程结果。测试仍是 Host owner 组合层，不是完整 ToolRuntime/Desktop；不承诺断电恢复。

下一步：确定性纯转换失败的独立 terminal proof，以及 SQLite accepted head → Git accepted ref 的 reconciliation；之后才能进入 Runtime/产品执行闭环。

## 第十检查点：确定性 Edit 拒绝的无副作用终态

新增内部 `acceptRejectedOperation`。它不接受 caller 声明的“无副作用”，也不为失败制造 candidate：从同一 execution group 的 durable T1 与 owner-bound accepted repository 读取原始参数和 immutable base，再运行纯转换。只有明确的 `ManagedMutationRejectedError` 才能形成 `operation_failed_no_effect` proof。

- **Owner**：Runtime 纯转换标记明确的 Edit 业务拒绝（缺少目标、匹配缺失/歧义、安全匹配限制等）；Host 从持久输入重验；Storage 私有 proof verifier 消费证明。普通异常、参数损坏、helper/object 读取失败不转为业务失败。
- **唯一结果**：失败 response 必须为 `isError: true`，其 canonical text 与重验得到的错误精确一致；terminal fact 由既有 SQLite writer 验证。伪造错误、缺 terminal、跨 owner 与成功操作冒充失败均不能释放 reservation。
- **原子边界**：沿用 SQLite T2/terminal + reservation release 的单事务，exact retry 不重复发布。无新 schema，无 accepted successor，无 Git ref 推进。
- **失败/回滚**：证据不足时保留 reservation、拒绝结算；不 fallback generic T2。撤销新入口不改写既有终态。该 proof 只适用于 immutable-input 纯转换，不能用于 filesystem worker、Bash 或任意外部工具。
- **结构**：成功、no-op、失败共享有界 T1/epoch/base 验证；保留不同 terminal writer 入口。Edit matcher 的明确拒绝改用 Error 子类，消息和匹配算法不变；未知异常原样传播。

真实 helper + SQLite 回归先 RED（没有失败结算 owner），再 GREEN：从实际 Edit matcher 得到失败，提交后子进程直接退出，不做 store/lease cleanup；新进程验证唯一失败 T2、零 successor、零 active reservation，原 head/content 可正常 reopen。还验证成功 Write 不能冒充失败，无需创建 candidate。此测试仍为 Host owner 组合层，不是完整 ToolRuntime/Desktop。

平台能力：Windows 本机执行真实 helper/process-exit 测试；Linux/macOS 由既有三平台 Gitoxide workflow 调度同一文件，但本轮未取得远程运行证据。不宣称断电恢复。

验证：Runtime matcher/纯转换 **29/29**，Host repository admission **21/21、0 skip**；Runtime/Host build、Biome、diff check 通过。workflow 的路径选择同时纳入共享 Edit matcher，避免后续匹配语义变化漏跑结算回归。

下一步不变：accepted-ref reconciliation，覆盖 SQLite 已接受而 Git ref 仍旧的重启状态；随后才接真实 Runtime/Host 与 Desktop。

## 第十一检查点：SQLite 接受后的 accepted-ref 修复

新增显式 helper operation `reconcile_accepted_ref`，与只读 `reopen_repository` 分开 attestation。旧的只读 capability 不获得写权限；未声明新 operation 的 helper fail closed，无 fallback，也不升版已有数据库格式。

- **事实 owner**：Host 通过同一 Execution Stores facade 读取当前 head、对应 immutable accepted version 和直接前驱；Storage 的 `readWorkspaceVersion` 从 canonical ledger 验证投影。目标 OID 和可替换的前驱 OID 不由工具调用者提供。
- **写入 owner/原子边界**：helper 验证 bare repository、目标 commit/tree 及完整对象图后，仅对固定 `refs/maka/accepted` 执行 direct-target compare-and-swap。`deref: false`，不能借符号引用改写其他 ref。当前值等于目标时幂等成功；只允许已证明的直接前驱转换成目标。
- **能力签发**：修复后仍执行严格只读 reopen；Host 再读 SQLite head，身份变化则拒绝签发 capability。修复不是新的 acceptance，不新增 T2/successor，也不重跑 Write/Edit。
- **失败状态**：未知/缺失/符号 ref、对象损坏或缺失、CAS 冲突且目标尚未收敛都拒绝。不会强制 reset、清除未知 lock 或把任意旧祖先当作可覆盖前驱。由 helper crash 留下的锁残留尚无自动回收协议；此类情况 fail closed，不宣称任意内部指令点崩溃均已自动收敛。
- **回滚**：撤回接线后旧代码对 stale ref 继续拒绝；SQLite 已接受事实保留，不删除 candidate/object，也不写相反终态。

回归先 RED：真实子进程已提交 successor 后退出，新进程因旧 ref 拒绝；接线后 GREEN。覆盖修改/新文件、修复后再次直接退出及 reopen、T2/successor 数量与内容不变；符号 ref、未知 ref、缺结果 blob 拒绝且不覆盖旧值。Rust 真实双进程同时修复同一目标，最终收敛并可幂等重试。

平台矩阵：Windows 本机已执行 Rust/helper/SQLite 真实进程测试；Linux/macOS 使用既有三平台 workflow，本轮未取得远程证据。仅承诺已测试的进程退出边界，不承诺断电。仍是内部 Host owner 组合，不是 ToolRuntime/Desktop 产品测试。

验证：Rust **14 unit + 58 integration = 72/72**；Host/helper/Storage authority 组合 **75 pass / 6 POSIX-only skip / 0 fail**，新增只读 attestation 禁止 ref 写入测试另 **1/1**。Storage/Host build、Rust fmt、Biome、diff check 通过。

下一步：真实 Runtime/Host managed admission 与结果发布；同时继续列出未决 T1/candidate 的恢复状态，不能把“已接受后的 ref 可修复”说成整个任务已可 Resume。

## 第十二检查点：Host 的只读 mutation admission

开始第二轮接线，先补 Host owner 的 `prepareMutation`，现有真实 Gitoxide/SQLite 进程测试改为消费它，不再自行拼写 workspace/base/profile 描述。当前主线 `prepareExecution` 属于 client-capability 权限合同，本轮没有借用该入口，也没有恢复旧 ToolRuntime 或 StoredMessage 双写。

- **主要不变量**：T1 输入中的 base/path/identity 来自同一 execution group 的当前 accepted head 与 owner-bound repository capability，而不是 caller 提供的 OID/profile。参数在第一次 await 前做平面字符串快照；Host 不规范化或改写路径和内容。
- **Owner**：Host 检查 epoch/helper/policy/head，读取 verified accepted-tree file 或明确 absence，随后重读 head、重检 abort。返回 immutable admission 数据，包括原参数 hash、base 内容和既有 v2 dispatch 描述。它不是新 filesystem 权限，也不是证明任意 executor 已遵守 profile 的能力；真正 Runtime 执行接线仍待完成。
- **原子边界**：admission 完全只读，不创建 T1/candidate/receipt；不声称它持有独占 reservation。两个 caller 可以同时完成 preflight，之后仍由 SQLite T1 的唯一 reservation 和 base CAS 仲裁。已存在未结算 mutation 则提前拒绝。
- **失败/回滚**：取消、非规范路径、参数 getter/非字符串/超限、错误 owner/workspace、旧 capability、读取后 head 漂移都在 T1 前拒绝。没有写入需要回滚。调用者在 admission 返回后仍需使用同一参数身份提交 T1，不能把该结果当成无条件执行许可。
- **参数范围**：首版只接受 Write/Edit 使用的平面字符串字段，合计最多 64 MiB；不运行参数 getter。Windows 的反斜杠输入目前在 T1 前拒绝，不会一侧规范化另一侧保留。未来若支持路径转换，必须在权限判断和 T1 之前统一处理。

测试先 RED（缺 admission owner），再 GREEN；修改/新文件/no-op/确定性 Edit 拒绝均经过真实 admission → SQLite T1 → candidate/terminal 路径。另覆盖参数在异步读取期间被 caller 修改、前置/在途取消、路径别名、getter 不执行、跨 workspace/owner、active reservation 拒绝及 head 推进后旧 capability 拒绝。

平台矩阵：Windows 本机执行真实 helper/process-exit；Linux/macOS 同一三平台 workflow 已纳入新文件选择，本轮无远程证据。无 filesystem mutation、无新 schema、不承诺断电；测试仍不是完整 Runtime Host 服务或 Desktop。

验证：Host admission/settlement/reopen 集成 **21/21、0 skip**，Gitoxide CI policy **1/1**；Host build、Biome、diff check 通过。

下一步：由 ToolRuntime 在 T1 前消费该 admission，冻结 managed/generic mode，并沿主线统一 modelProjection/commit-before-publish 路径结算。Desktop 开关仍不得先启用。

## 第十三检查点：真实 ToolRuntime → Gitoxide/SQLite settlement

本轮不搬回旧 ToolRuntime：在当前单权威 transcript 路径内，增加显式注入的 managed mutation preparation port 和内部 Host adapter。普通会话未注入该 port 时行为不变；尚未接 live Host session composition 或 Desktop。

- **主要不变量/owner**：Runtime 持有原始参数、纯转换和 provider result；Host 只持有 repository/candidate/terminal 提交权限。Host 不接收 operation callback，不得替换 Runtime 的结果。结果由既有纯转换生成并冻结，不克隆任意工具实现返回的对象；使用冻结 profile 的 1 MiB result 上限（nested caller 上限更低时取较低值）。
- **T1 前**：完成 execution boundary、permission mode、Host admission，校验参数 hash 与 canonical path，快照 mutation/base。实际执行与 T1 使用同一原始参数，Host 不能改写 Write content 或 Edit 字符串。完整 dispatch envelope 校验后，SQLite 原子写 T1/reservation；recovery mode 固定为 reconcile。
- **T1 后**：不调用 checkout-backed `tool.impl`，直接从 accepted base 计算结果。Runtime 构建完整 function_response/modelProjection；Host 创建 candidate，再从 durable T1 重验内容并调用原有 successor/no-effect writer。返回的 durable event 必须与 Runtime 隔离保存的完整 envelope 精确相等，之后才发布 tool_result。无 StoredMessage 双写，无新 schema。
- **终态**：changed success → successor/T2；no-op success → no_workspace_change/T2；明确的 Edit matcher 拒绝 → operation_failed_no_effect/T2。拒绝文本与 Host 重验使用同一脱敏/截断函数。三种 terminal 均由 SQLite 同事务释放 reservation。
- **失败状态**：缺失/变造 outcome、owner throw、未知 transform/projection/publication 错误均 fail-stop，不走 generic T2 或 checkout compensation。若 T2 已提交而发布失败，接受事实仍然成功，不生成第二个失败结果。
- **取消**：T1 前 abort 拒绝；T1 后允许这次无外部执行副作用的纯转换完成有界 helper/SQLite 结算，不把已经取消的 signal 传给 terminal writer。不是 Bash/网络副作用的取消合同，也不承诺即时停止。helper 启动/执行仍受既有 deadline 约束。
- **回滚**：撤回 port 的产品接线不会删除已接受历史；含未决 managed T1 的任务不能改走 generic 执行。产品接线前仍保持内部能力，不开放 Desktop 按钮。

验证由两层组成：Runtime boundary 覆盖 T1 绑定、owner-only T2、missing/changed/throw fail-stop、T1 前 boundary 失败和 T1 后取消；真实 child 使用 ToolRuntime、内部 Host adapter、Gitoxide helper 和 SQLite，覆盖 Write/no-op/Edit 拒绝的正常发布与 T2 后直接退出，新进程验证结果/terminal/reservation、accepted-ref 修复和源 checkout 不变。

**平台矩阵**：Windows 本机执行上述真实进程测试；Linux/macOS 由三平台 Gitoxide workflow 调度相同文件，本轮未取得远程执行证据。仅证明已设置的进程退出边界，不证明断电、helper 内任意指令点退出或遗留 ref lock 自动回收。测试尚未启动完整 Runtime Host 服务或 Electron，因此不能称为 Desktop resume 验收。

本轮验证：Runtime durable-boundary + Host repository/admission 集成 **55/55、0 skip**；CI workflow policy **1/1**；Runtime/Host build、Biome、diff check 通过。额外普通 settlement/SQLite/sandbox/纯转换/Edit matcher 回归 **66 pass / 1 fail**：失败是原有 sandbox fixture 创建 symlink 时 Windows `EPERM`，尚未进入被测逻辑；本轮不修改该 fixture，也不宣称完整平台测试全绿。

下一步：live Host/session composition 每次从 accepted head reopen，接入同一代码世界的 Read/Glob/Grep；随后才开放加号菜单的显式 managed 文件任务入口，并补真实 Host/Electron kill/restart。当前不能宣称整个 coding task 已可恢复。

## 第十四检查点：session 绑定与真实 backend 连续执行

本轮增加 Host 内部 managed session capability，将既有 workspace epoch 绑定到 session ID 和同一个 Execution Stores runtime sink。每次 mutation/read 都从 SQLite 当前 accepted head reopen，不缓存首次 admission 的旧 head。真实 AiSdkBackend 将显式 managed port 传入 ToolRuntime，普通会话不注入时保持原行为。

- **Owner/权限**：WeakMap 签发并验证 session capability；伪造、浅拷贝、跨 session、不同 sink 均拒绝。Host backend 创建/准备在读取 provider credentials 前校验，activation 再按实际 context 校验。Runtime 把 session ID 传到 preparation；Host 在创建 candidate 前拒绝跨 session outcome。
- **原子边界**：session capability 本身不创建 epoch、不写 T1，也不新建事务协议。每次操作继续使用既有 SQLite T1 reservation 与 terminal transaction；head 在 reopen 后变化仍由 T1 base CAS 拒绝。此次没有 schema/profile 迁移。
- **失败/回滚**：关闭 execution stores 后的新 admission/read 被拒绝；缺失或错误 capability 不得降级为普通模式。撤回显式注入不删除已接受事实，也不能把已有 managed T1 改走 generic writer。Host 产品接线仍须先 drain 活跃执行再关闭 stores，不能把这些检查当作任意在途 callback 的完整撤权证明。
- **测试证据**：先复现 backend 丢失 managed port，再复现复用旧 repository capability 导致第二次 Edit 失败。修复后，同一真实 AiSdkBackend 连续 Write→Edit→accepted read 得到第二个结果；另一个子进程在首次 T2 后、结果发布前直接退出，新进程 reopen 得到首次已接受内容，ledger/reservation 收敛且源 checkout 不变。只有外部模型使用模拟输出；Runtime、Gitoxide helper、SQLite 均真实运行。
- **尚未接通**：未启动完整 Host IPC/election 或 Electron。当前 session→epoch 关联由内部调用方提供，尚未写入产品 session/profile 创建协议；accepted read 是内部 owner 方法，不是完整 Read/Glob/Grep 工具组合。不能称为 Desktop 或整任务自动 Resume 完成。

平台矩阵：Windows 本机上述两条真实 backend/process-exit 测试通过；Linux/macOS 由同一三平台 workflow 调度，本轮尚无远程证据。不承诺断电或任意 Gitoxide 内部指令点崩溃恢复。

定向验证：backend 连续执行/退出恢复 **2/2**；Host backend 创建/activation/伪造能力 **10/10**；Runtime durable boundary **28/28**；AiSdkBackend durable 回归 **18/18**；CI policy **1/1**。这些是定向结果，不代表全量测试或完整产品能力通过。

下一步：持久化的显式 managed session/profile 创建与 Host 能力协商，接同一 accepted world 的读取工具，再开放 Desktop 加号菜单入口和真实 Host/Electron crash 验收。不恢复旧 StoredMessage 双写，不引入系统 Git/npm 依赖。

## 第十五检查点：accepted-world Read 与工具集合收窄

在开放 session 创建前先关闭混合读取问题：真实 backend 已能 Write/Edit accepted tree，但原 Read 仍读取 source checkout。回归首先观察到 `accepted original` 而不是第二次修改的 `second result`；本轮将 managed Read 的实现收归 session owner。

- **主要不变量/owner**：显式 managed session 的 Read 只读取当前 SQLite accepted head 对应的 immutable Git tree，不读取 cwd 或 checkout。实现由 session capability 签发，校验实际工具上下文的 session ID；不沿用原 Read 的 implementation、prepareExecution 或 permissionArgs。
- **工具权限**：当前只保留上层已提供的 Read/Write/Edit；不会凭空补齐被 Plan/权限层删除的工具。Bash、Glob、Grep、apply_patch、插件等尚未证明属于 accepted world 的工具暂不进入该集合。动态工具解析和初始 RunComposition 的 catalog hash 使用同一投影；managed backend 不注入普通 child-agent 能力。普通 backend 不走此投影。
- **读取边界**：每次调用先 reopen 最新 accepted head，随后 helper 读取该次固定 commit 的文本 blob；本次读取期间后续 head 前进不改变这次 blob。分页复用主线 `readPage`，返回有界页面，continuation 校验内容摘要。只接受 helper 验证的 canonical repo-relative 文件路径；不支持用户目录、图片或任意 Maka runtime resource。既有 backend 专属结果归档资源机制不因此变成 checkout 权限。
- **持久化/失败**：Read 沿当前通用 durable tool 协议提交结果，不引入新 ledger 或 schema。路径越界、错误 session、取消、helper/accepted identity 错误均拒绝，不回退 checkout。已提交的 Read outcome 从 ledger 重放；未提交读取的重试可以观察新的 accepted head，当前尚未承诺整个 continuation 固定同一 causal boundary。
- **回滚**：禁用 managed session 注入即可停止新入口；不能把已有 managed 任务改成普通 checkout 任务。此检查点未开放 Desktop，也没有新增磁盘工作树 projection。

验证：真实 AiSdkBackend 的 Write→Edit→Read 得到 accepted 新内容，独立进程 reopen 后结果一致，source checkout 保持原样；T2 后退出用例继续通过。另覆盖跨 session、父路径、runtime 地址拒绝和行范围读取。真实 helper/backend 两例 **2/2**，Host backend 定向 **10/10**，主线分页 **7/7**，workflow policy **1/1**；Host build、Biome、diff check 通过。

平台矩阵：Windows 本机执行以上验证；Linux/macOS 使用相同 Gitoxide workflow，新增 `read-page.ts` 变更选择范围，本轮没有远程运行证据。不扩大此前进程崩溃承诺，不宣称断电恢复或完整 Electron 恢复可用。

下一步仍是持久化 managed session/profile 与 Host admission 接线。Glob/Grep 需要 accepted-tree 枚举/搜索 owner，当前不能通过放回普通工具来补齐；Desktop 加号入口须等待该产品合同明确后再开放。

## 第十六检查点：显式持久化 profile 与禁止降级

新增 `managed-files-v1` Session tool profile，沿现有严格 protocol decoder 和 SessionHeader JSON 持久化，不新增数据库 schema 或旧实验格式兼容。profile 只定义 Read/Write/Edit、隔离 accepted tree、不可运行命令/测试/依赖安装/Publish；关闭 memory extraction。它不是 repository admission capability。

- **主要不变量**：模式由 persisted profile 声明，执行权限由 Host 的真实 session capability 提供，缺任一边不能进入普通执行。Host 在读取 provider credentials 前验证配对，prepared activation 按实际 context 再验证；AiSdkBackend 自身也拒绝 managed profile 缺 preparation port/runtime sink，或普通 profile 注入 managed preparation port。
- **Owner/原子边界**：Session metadata owner 按原协议保存 profile；workspace accepted truth 仍在 RuntimeEvent/SQLite authority 中。单独写 profile 不会建立 epoch、import repository 或领取 reservation。本轮并未实现 session 与 baseline 的跨资源创建协议。
- **创建入口收口**：普通 session.create、Host create 和 WorkHub prepare 共用的创建校验明确拒绝 `managed-files-v1`，直到专门 workspace admission owner 接入。协议识别该值不等于允许用户创建半成品任务。普通 profile 不受影响，不默认启用 managed，不靠普通 cwd 推导权限。
- **失败/回滚**：缺能力或模式错配在 backend/T1 前拒绝，不调用 generic Write/Edit；撤回功能不得把已持久化 managed profile 改成普通模式。旧 binary 不认识该 profile 时应拒绝，不建设实验分支降级兼容。

TDD 先复现未知 profile、managed profile 缺能力仍读取凭据、AiSdkBackend 静默构造 generic backend，以及普通创建入口可接受未经 admission 的标签；随后封闭这些路径。SQLite reopen 回归验证 profile 保留且 schema 版本不变；真实 backend/crash fixture 已使用显式 profile。

验证：Core/Runtime/Storage/Host build 通过；真实 helper backend/process-exit **2/2**，Host backend 定向 **11/11**，AiSdkBackend durable/mode 定向 **19/19**，SQLite profile reopen **1/1**，CI policy **1/1**。profile/catalog 扩展回归 **59 pass / 2 fail**，两条失败均在 Windows fixture 创建 symlink 时 `EPERM`，未执行相应业务逻辑；本轮未修改或跳过它们，不宣称全量绿。

平台矩阵：Windows 本机具备上述证据；Linux/macOS 由现有三平台 workflow 调度新增 profile/admission 回归，本轮未取得远程结果。没有新增恢复协议，不扩大断电承诺。仍未开放 Desktop/CLI managed 创建入口。

下一步：以 session ID 绑定 import destination/workspace key，设计并验证 import→baseline→session 的可重试创建 owner（中断时不得出现可执行但缺 baseline 的会话），再将 capability 重建接入 live Host backend factory。随后开放显式 Desktop 入口，而非让普通创建 API 接受裸 profile 绕过 admission。

## 第十七检查点：accepted baseline → Session 发布

核对实现后确认：当前 Rust import 使用 fresh-destination claim；不能对半完成目录简单重新调用 import。本轮不把“捕获异常后重试”包装成完整创建恢复，而先闭合已经接受 baseline 之后的 Session 发布边界。

- **Owner/主要不变量**：`createGitoxideManagedSessionInternal` 只消费同一 Execution Stores 中以 session ID 为 workspace key 的已接受 epoch。调用 baseline owner 严格 reopen（含 helper、repository、accepted objects/head 验证）成功之后，才调用现有 stable Session create；返回 capability 与该 Session/Runtime sink 绑定。缺 baseline 不创建 Session。
- **模式和请求身份**：Owner 只接收有界的 session/source/repository/model/name 字符串与真实 helper capability，不接收任意 CreateSessionInput。固定 managed-files-v1、direct、ask、agent/default；不允许注入 plugin executor、子会话或 bypass 字段。固定字段序列的 SHA-256 fingerprint 绑定创建意图与 repository path；同请求返回 existing，变化请求返回 conflict。
- **原子边界**：baseline 与 Session 不是一个跨资源事务。baseline 先存在；Session 的唯一创建/重试由原有 SQLite stable-create 协议仲裁。进程在 baseline 后退出可留下无 Session 的 accepted workspace，但不会留下有 Session、无 baseline 的成功创建状态。已有 Session 的重试仍重验 accepted repository，不把 metadata 的 existing 结果当作执行权限。
- **取消/失败/回滚**：前置取消及 reopen 后、Session commit 前取消都拒绝；commit 已开始后的不确定结果通过同 fingerprint 重试确认，不做反向删除。冲突不覆盖已有 Session；reopen 失败不退到 generic 或 source checkout。未发布 baseline/对象暂时保留，不能在此路径递归清理用户目录或猜测垃圾所有权。

真实 child-process 测试：baseline 提交后直接退出 → 新进程发布；Session 提交后直接退出 → 新进程 exact retry；都验证只有两条 baseline authority facts、同一 accepted 内容、source checkout 不变。另覆盖缺 baseline、预先取消、重复请求和变更创建意图。测试不是异常模拟，也不是完整 Host/Electron 启动测试。

验证：新增 publication 两例及既有 backend 连续执行/退出恢复 **4/4、0 skip**；Host backend 定向 **11/11**；CI policy **1/1**；Host build、Biome、diff check 通过。三平台 workflow 已调度该测试文件。Windows 为本机证据，Linux/macOS 本轮未取得远程执行结果；不承诺断电或 import 内部任意指令点恢复。

尚未完成：半完成 import 的可信 intent/重验/隔离协议；source admission 与完整创建请求的绑定；根据 storage root/session ID 重建 repository 路由；live Host 创建和 reopen 接线。当前 API 接收可信内部调用者提供的已接受 repository 路径，尚不是用户创建 API，普通 session.create 的 managed 禁止规则保持不变。下一步优先闭合 import 前半段，而不是提前开放 Desktop。

## 第十八检查点：已完成 import 的只读重验

新增独立授权的 `verify_source_import`，覆盖 helper 已发布完整对象图与 baseline ref、但 Host 尚未接受 baseline 或收到结果的窗口。原 `import_source_head` 仍只接受 fresh destination；不因新增核验操作而给旧 import capability 扩权。

- **Owner/主要不变量**：Rust helper 重验源 observation、目标 bare SHA-1 repository、direct baseline ref、精确 deterministic baseline commit 字节及完整 tree/blob 图。Host 只从经过 admission 的 source capability 发起核验，并将验证结果转换为原有 owner-bound accepted repository capability；目录存在或 tree 相同本身都不构成成功。
- **原子边界**：本操作不写对象、ref、receipt 或 Session，也不补齐缺失内容。核验后 baseline/Session 发布继续由既有 authority 负责，未新增跨 Git/SQLite 事务。
- **失败/回滚**：缺 ref、缺 blob、symbolic ref、同 tree 但不同 baseline commit 均拒绝，残留保持原样。失败不尝试删除目录、不重新 import、不降级到 source checkout。取消/deadline 复用现有 helper invocation owner。
- **证据边界**：核验只证明目标与本次显式 source observation 一致，不能倒推出丢失请求的原始 source commit。baseline commit 绑定 tree；source 若产生相同 tree 的新 commit，原创建意图仍需要未来 durable import intent 保留，不能把当前重验当作历史意图恢复。

真实进程测试新增 import 完成后直接退出（尚未接受 baseline），新进程通过只读核验再发布 baseline/Session，并验证 exact retry、唯一 baseline facts 和 source 不变。Rust 回归覆盖完整 import 跨 helper 进程核验，以及四类损坏不被修补。旧 helper 操作授权集合不能调用新核验操作。

验证：Rust 全套 **74/74**；Host publication/backend/独立操作授权定向 **6/6、0 skip**；Host build、Biome、diff check 通过。平台矩阵：Windows 本机验证；Linux/macOS 沿现有三平台 workflow 调度同一测试文件，本轮没有远程运行证据。仅证明已完成 import 后的进程退出窗口，不承诺断电或 helper 内部任意指令点退出后都能恢复。

下一步：持久化原始 import 创建意图与 destination 所有权，明确半完成 artifact 的隔离/重建协议，再接 live Host 路由。当前仍未开放 Desktop 创建入口，不宣称整个 managed task 创建恢复已完成。

## 第十九检查点：import 原始身份记录

先用真实 helper 复现：source 产生一个同 tree 的新 commit 后，旧 import 可以被上一检查点的只读核验接受为新 source observation。本轮在 fresh destination 内增加 `refs/maka/import-intent`，指向固定字段序列的 JSON blob，绑定规范 source gitdir、原始 source commit/tree、规范 destination、baseline ref 和 policy。记录在 source 对象复制和 baseline 发布之前创建，使用 MustNotExist ref 写入，不允许本路径覆盖已有 intent。

- **Owner/主要不变量**：import helper 拥有该准备记录；verify 必须读取 direct intent ref，按 64 KiB 上限校验 blob 类型、checksum 和精确字节，再验证 baseline/object graph。相同 tree 不再允许 source commit 身份偷换。intent 只描述创建请求，不代表 accepted workspace，SQLite RuntimeEvents 仍是 accepted truth。
- **原子边界**：intent blob/ref、source 对象复制和 baseline ref 发布仍是分阶段操作，不声称统一事务。intent 不存在、未写完整、对象缺失或 baseline 缺失都拒绝；未完成状态不会被升级为成功。当前只读核验不恢复 intent，不重写 ref。
- **权限/回滚**：该记录不是目录 inode/OS 所有权 capability，也不授予 rename/delete 权限。失败保留残留，不删除用户文件，不自动重建。移走 repository 或替换 source 身份会拒绝。此未发布实验切片不兼容缺少 intent 的旧实验 import；可保留旧目录另建新实验任务，不建设迁移或降级框架。
- **创建意图范围**：记录尚未绑定 session ID、model/name 或 storage-root owner。已有 Session stable-create fingerprint 仍负责 baseline 后的请求一致性；两者尚未合成为用户可调用的完整创建 owner。不能凭此开放普通 session.create 或宣称半完成 import 自动恢复。

验证：同 tree/新 source commit 回归先 RED（旧实现接受）后 GREEN（import_intent_mismatch）；增加 missing/symbolic/oversized intent 拒绝且不修补的检查。Rust 全套 **75/75**，真实 Host fixture publication/backend 进程测试 **5/5**，Rust/TypeScript error contract **1/1**，Host build、Biome、diff check 通过。import 后退出的新进程核验现已实际消费 intent。

平台矩阵：Windows 本机通过；Linux/macOS 由既有同文件三平台 workflow 调度，本轮无远程结果。承诺范围仍是被测试的进程退出恢复，不包含断电持久性、任意 helper 内部指令点收敛或不可信本机进程篡改整个私有 repository。

下一步：由 storage-root/session 创建 owner 固定完整请求与 repository 路由，明确未完成 attempt 的身份与隔离方式，再接 live Host。这里不增加自动清理、全盘扫描或 Desktop fallback。

## 第二十检查点：root-owned managed task 创建

新增内部 `createGitoxideManagedTaskInternal`，只接受真实 interactive write lease、helper capability 和有界 Session 请求，不接受调用方指定 repository 路径。目录由已验证 root 与 session ID 的 SHA-256 推导，stores 也由同一 lease 打开；同 lease 的创建串行化，整个执行持有 root operation，关闭 root 不能绕过在途创建。

- **主要不变量/owner**：创建 owner 决定 source admission → fresh import/只读重验 → baseline acceptance → stable Session publication。完整固定 Session 请求与 repository 路径的 fingerprint 同时进入 import intent 和 Session stable-create；在 Session 尚未发布时更换 name/model/connection 等字段也会被拒绝。Rust 对 fingerprint 使用严格 SHA-256 格式校验并纳入精确 intent 字节。通用低层 repository import 可以不关联 Session fingerprint，但本创建入口始终提供，不能消费无绑定 import。
- **原子边界**：没有把 Git 与 SQLite 伪装成一个事务。Git intent、baseline ref、SQLite baseline 和 Session 分阶段发布；Session 最后创建。已有目录只走严格 verify，不因存在就接受，不 catch 后 fallback fresh import。Session 已存在时验证 stable fingerprint、当前 accepted head 与对象图，不重新导入 source 或把 head 回退到 baseline。
- **权限与失败**：浅拷贝/伪造 lease 被 root authority 拒绝；source rejection、部分 import、intent 冲突、取消均不发布新的可执行 Session。取消在排队期间最迟在本次进入 owner 时检查，尚未实现即时移除排队请求；helper 内工作继续用原有 deadline/signal。失败保留残留，不授予递归删除或重建权限。当前不是不可信 IPC 请求处理器，也不替代 connection/model 的产品授权。
- **回滚**：撤回新创建入口即可停止新增任务，不能把已存在 managed profile 改成普通模式。已发布事实继续依赖 accepted-head reopen；未发布 artifact 留待单独的 owner-bound 隔离协议。没有新增 SQLite schema，也不为旧实验 intent 格式补迁移。

测试先以未实现的创建入口证明无法完成真实 child-process create，再接入真实 helper/SQLite owner。新增两条进程证据：完整创建后进程退出，新进程用同一请求重开；import 完成后进程退出（该 fixture 显式调用同一底层 import seam），新进程先拒绝被替换请求，再用原请求完成创建。后者不冒充在新创建函数内部任意位置 kill 的证明。两条都验证同一 baseline facts、source 不变，并覆盖重复/并发请求、伪造 lease 与预先取消。

验证：Rust **75/75**；Host publication/backend 定向 **7/7、0 skip**；跨语言错误协议 **1/1**；Host build、Biome、diff check 通过。平台矩阵：Windows 本机执行；Linux/macOS 由现有相同测试文件的 workflow 调度，本轮未取得远程结果。不承诺断电、helper 任意内部指令点恢复或半完成目录自动回收。

下一步：live Host 创建 handler 和按持久化 Session 重建 capability 的接线，保持普通会话不受影响；完成真实 Host IPC/election 验证后，才开放 Desktop 加号菜单入口。该检查点仍是内部创建 owner，尚不能称为 Desktop 产品闭环。

## 第二十一检查点：持久化 Session 重开与 Host backend preparation

新增 `reopenGitoxideManagedTaskInternal`：只接收真实 root write lease、session ID 和已授权 helper，不再要求恢复调用者带回原始创建请求或 repository 路径。创建/重开共用 root + session ID 的目录规则；读取真实 Session，拒绝普通 profile 和 plugin executor，再根据 SQLite accepted head 及 Git 对象重建 capability。重开结束前重查 persisted mode 与取消状态。

- **Owner/主要不变量**：持久化 Session 决定是否为 managed task，root authority 决定目录，workspace authority 决定 accepted 内容。cwd 不作为恢复内容来源；source checkout 外部修改不被导入、覆盖或当作当前 head。这里不自动切换 mode，也不发布新 baseline/Session。
- **Host 接线**：默认 ai-sdk backend factory 现在调用 `prepareHostAiSdkBackendFromRoot`。managed profile 必须有内部组合层传入的真实 helper capability，先完成重开并验证同一个 runtime sink，才读取 provider 凭据；缺 helper 明确拒绝。普通 profile 继续走原 preparation，不要求 helper，不访问新 root 路由。传入的是能力对象，不增加 executable path、PATH discovery 或 IPC 自签发入口。
- **原子/生命周期**：重开持有 root operation，沿原 accepted-ref reconciliation 与对象验证协议，不新增事务、schema 或接受事实。每次 backend preparation 重新构建，不持久缓存内存 token。错误不能回退 checkout/generic managed mutation；停止注入 helper 只关闭 managed 执行，不应让普通会话无法发送。
- **验证边界**：真实 child-process 创建/退出后，新进程按 session ID 重开；source 被改成不同内容时仍读到 accepted 内容且不覆盖 source。普通 Session 重开被拒绝；真实 root/helper/sink 能走到 provider 边界，错误 sink 在该边界前被拒绝。provider 只以受控 sentinel 标记是否抵达，没有发真实网络请求。没有声称启动完整 Host election、IPC 或 Electron。

Windows 定向：两条真实进程 task 创建/重开 **2/2**；Host backend creation/preparation 回归 **11/11**；CI gate policy **1/1**；Host build、Biome、diff check 通过。三平台 workflow 的选择范围加入 production execution-composition，测试 pattern 纳入 root preparation；Linux/macOS 本轮无远程结果。不扩大断电/完整任务自动恢复承诺。

仍未开放产品入口：当前发行/bootstrap 尚未给 execution composition 提供 helper capability；默认未配置的 Host 会明确拒绝 managed profile。接下来需要明确 packaged/dev helper admission 与 Host capability negotiation，再将专门 task 创建 owner 接入经过 model/workspace 授权的 session handler。普通 session.create 的 managed 禁止规则保持不变，Desktop 按钮不提前开放。

## 第二十二检查点：candidate → lazy composition 的 helper 传递

核对真实启动链发现：上一检查点只给 execution-composition 加了 helper dependency，而 execution-candidate 使用另一层 composition-source factory；后者没有传递该 dependency。本轮将它纳入 candidate dependency 类型及懒加载 factory，避免“底层支持注入”被误当作“启动入口已经能消费”。

- **Owner/主要不变量**：内部 bootstrap 提供已签发的 invocation capability；factory 立即保存 binding 快照，只在赢得 root 后执行 composition.create 时检查完整操作集合并重验 artifact bytes，再将同一能力交给 execution composition。后续修改调用方 binding 不改变本次启动权限。裸对象、缺操作和 hash 不符不能作为 managed runtime 被安装。
- **生命周期/失败**：未提供 helper 时完全保留普通 Host 启动，不访问 helper artifact。显式提供无效能力则拒绝本次 candidate startup，不悄悄丢弃权限后宣称支持 managed。artifact 验证复用现有绝对 deadline；底层 Node 文件系统调用无法强制取消的限制仍存在，迟到结果不进入 composition。没有增加 CLI 参数、PATH discovery 或任意文件路径自授权。
- **边界**：此处只转交既有内存能力，不产生新的 durable truth，不改变 SQLite schema 或 managed mode。没有新增恢复算法；既有真实 candidate 子进程测试继续证明昂贵执行模块在 root election 后加载，loser 不启动执行图。完整 helper 发布、平台签名 trust root 与客户端能力协商均未在此完成。

验证：先以 forged helper 重现旧 factory 静默忽略 dependency（本应拒绝但继续启动），再修复。factory 测试验证无 helper、伪造能力、真实 helper 文件的已签发能力转发、调用方 binding 后改不生效以及 same-size byte tamper 拒绝；该测试核验 artifact，不声称执行了 helper 命令。factory + 真实 candidate startup 回归 **7/7、0 skip**；CI gate policy **1/1**；Host build、Biome、diff check 通过。新文件进入三平台 gate 选择与测试清单。

平台矩阵：Windows 为本机证据；Linux/macOS 由同一 workflow 调度，本轮未取得远程结果。没有新断电保证。下一步仍需真实发布/dev bootstrap 签发 helper capability、按实际可用能力设计客户端协商，再开放专门创建 handler；不能因为此内部转发已接通就打开 Desktop 按钮。

## 第二十三检查点：显式开发 helper bootstrap

增加独立的 `dist/test-only/managed-files-candidate-main.js` 开发入口。启动者通过 `MAKA_MANAGED_FILES_DEV_HELPER` 提供严格 JSON：`schemaVersion: 1`、绝对 `executablePath`、`expectedBytes`、带 `sha256:` 前缀的 `expectedSha256`、当前 `platform` 与 `arch`。入口捕获后立即删除该环境变量；不存在 PATH 发现、旁边 manifest 自动信任或 production entry 环境开关。

- **Owner/权限**：这是开发者显式选择并固定二进制字节，不是已签名发行包身份，也不抵御恶意开发启动者。复用 artifact authority 签发 invocation capability，不代表新增了发行信任根。两个 test-only 模块都由发行过滤规则排除。
- **生命周期**：candidate 赢得 root、建立 startup 生命周期后，lazy composition 才运行 prepare callback。loader 在首次异步 admission 前创建绝对 deadline，校验文件大小、摘要和平台；factory 再校验操作集合及 artifact。失败拒绝本次开发启动，不静默降级；没有 helper 的普通生产 Host 路径保持不变。已签发能力与 prepare callback 同时提供会拒绝，避免两套启动 owner。
- **原子/回滚**：只建立进程内权限，无新 SQLite schema 或 durable 接受事实。删除开发入口或停止显式使用它即可撤回，不转换任何 Session mode。底层不可取消 Node 文件系统调用的既有限制不变；本次不承诺新的进程崩溃或断电收敛。
- **证据**：loader 使用真实 helper 字节验证并拒绝错误摘要；真实 candidate 子进程在获得 root 后拒绝畸形配置，持有同 root 时则以 loser 状态退出且不读取配置。另保留真实 artifact 转发、篡改拒绝及 production module graph 不可达 test-only 的验证。这不等于完整 Host ready/IPC/模型/Executor/Electron 验收。

Windows 本机 Host build、定向测试 **11/11、0 skip** 通过。Linux/macOS 纳入同一 helper gate，尚未取得本轮远程结果。该入口不自动接入 Desktop launcher；后续仍需 Host capability negotiation、经过产品授权的 managed task 创建 handler、Desktop 加号入口，以及独立的正式发布资源验证。

CI gate policy **1/1**、发行文件策略组 **13/13** 通过；完整 release-cli-file-policy 文件执行为 **14 pass / 1 fail**，失败项是本地未生成 `packages/computer-use/dist/index.js`，不作为本切片全量验证通过的证据。Biome 与 diff check 通过。

## 第二十四检查点：Host 执行能力只读查询

新增 `host.execution-capabilities.query`，返回当前 `hostEpoch`、lifecycle `state` 与 `managedFilesResume`。握手成功只证明连接已获准，不证明 execution composition 已恢复；查询在 bootstrap 阶段可用，但仅在 ready 且 composition 明确安装了 helper 时公布 resume 能力。该字段仅表示可尝试重开已有 `managed-files-v1` Session，不表示允许创建新任务、自动恢复、Bash/npm 或 Desktop 产品入口已完成。

- **Owner/主要不变量**：candidate composition factory 在 helper capability、完整操作集合、artifact 字节验证后，给成功创建的 composition 固定不可改写的可用性字段；普通无 helper composition 为 false。kernel 结合自身 lifecycle 产生查询结果。客户端不能通过输入上报能力，严格 decoder 拒绝额外字段、非布尔值及非 ready 状态宣称可用。
- **权限边界**：查询是提示，不是执行 capability。每次 backend preparation 仍重验 Session mode、root、accepted head、sink 与 helper；查询成功后发生 drain/tamper 时必须在执行处拒绝。它不授权 source 路径或读取内容。没有修改 election、强制终止现有 Host、无 helper fallback 或通用 session.create 的限制。
- **原子/失败/回滚**：无新 durable 事实、schema 或多库事务。内存能力只在 composition 创建成功后公开；recovering 不公布可用。新增严格 operation 将 compatibility epoch 从 161 提升至 162，旧客户端/Host 在握手拒绝，不留到首个请求才失败。回滚需客户端与 Host 同版重启，不能把既有 managed Session 转为普通模式。
- **测试**：factory 的缺能力/真实能力发布先 RED 再 GREEN；protocol 测试先证明缺少查询，再实现 strict decoder。真实 listener/connection 测试验证普通 Host ready 为 false，同一连接在 recovering 为 false、ready 为 true，并绑定同一 epoch。两条既有启动测试在本机约 1.2 秒抵达 composition，原 1 秒等待稳定失败；仅将测试握手预算改为有界 5 秒，生产 timeout 不变。

Windows：Host build、协议/dispatcher/connection/peer stream/factory **125/125**，真实 kernel 定向 **2/2**，CI gate policy **1/1**，Biome、diff check 通过。Linux/macOS 使用同一 gate 新增的查询/生命周期用例，本轮未取得远程结果。未新增 crash 或断电保证，未运行 Electron。

下一步：让 Desktop/任务创建调用者在同一连接上消费此查询并明确处理不可用，再接经过 connection/model/workspace 授权的专用创建 handler。当前只完成可观察的能力报告，不能称为客户端协商闭环，更不能提前展示可点击的 managed 创建按钮。

## 第二十五检查点：客户端显式要求 managed resume

`connectOrSpawnRuntimeHost` 增加可选的 `requireManagedFilesResume: true`。未提供时不增加查询、不改变普通连接行为；提供时在连接到 ready Host 后，使用同一 connection 查询 `host.execution-capabilities.query`，同时核验响应 Host epoch、ready 状态与 resume 标志。这是现有 session 的 resume 条件，不是创建权限。

- **Owner/边界**：client election owner 在首次异步操作前固定要求，非法 false/string/number 输入在访问 storage 前拒绝。query 与 ready 等待共用 election 剩余 deadline，并接入原 AbortSignal；不能重开一个完整超时窗口。响应无法证明执行权限，后续操作仍以服务端逐次 admission 为准。
- **失败**：明确缺能力、非 ready 或 epoch 不同会抛出带稳定 `managed_files_resume_unavailable` code 的错误，关闭本次连接，且不把它吞成普通 ready-wait retry。没有静默 fallback、没有杀死或替换 resident Host。传输失败仍沿原选举期限处理，不能返回未经验证的 connected。调用方未要求时不受此门槛影响。
- **原子/回滚**：只在返回 connected 前增加检查，无 durable 写、schema 或 protocol epoch 变动。撤回调用方要求恢复普通连接行为，但不能更改 Session 的持久化 mode。当前 Desktop 尚未设置该参数；并未声称完成 Desktop 创建/恢复 UI。
- **证据**：真实 root owner/listener/client 测试先重现旧行为无视要求而返回 connected（RED），再验证 ordinary resident 被拒绝、零 candidate launch、失败连接释放，普通客户端仍连接同一 ready epoch。已支持的 ready Host 则复用，无新进程。recovering→ready 使用同一真实 Host 验证。

Windows 本机：Host build、定向能力/生命周期测试 **4/4**、输入/env 测试 **6/6**、CI gate policy **1/1**、Biome、diff check 通过。另执行历史 handshake compatibility suite，**2 pass / 4 fail**（`read_eof`），本轮未定位，不能声称连接全套通过。Linux/macOS gate 已加入新增选择路径和用例，尚无本轮远程证据。没有新增 crash/断电承诺。

创建链审计确认 `HostSessionCatalogCoordinator` 已拥有 Session admission、workspace usage、模型/connection 解析、runtime policy 默认值和 stable-create 指纹。下一步应从这一 owner 接专用 managed 创建，而不是暴露 `createGitoxideManagedTaskInternal` 为裸 IPC。现有普通 `session.create` 对 managed profile 的拒绝必须保留，直到上述授权、Git baseline acceptance 与 Session publication 在同一交付中接通。

## 第二十六检查点：关闭 Windows 握手测试的维护连接误判

上一检查点的四项 `read_eof` 已定位：`prepareAfterListen()` 在 Windows 通过真实 PowerShell `Get-Item`/ACL 设置访问 named pipe；测试 peer 在这一阶段已把每条 socket 送入 Client hello parser。该维护连接不发送 hello，关闭时错误地完成/拒绝了测试唯一的 server promise。四个失败用例均运行端点准备；绕过端点准备的 root-mismatch 用例不失败。

fixture 现在区分 endpoint preparation 与握手 admission：准备期间仅排空 socket，不登记 Client 身份；ACL 完成后才接受协议连接。保留真实 ACL 设置，不改生产 listener、timeout、兼容策略或 resume 行为。断言真实 Windows 准备连接被观察到，并且每个需要连接的用例仅有一个真正握手，不能靠忽略所有 EOF 让测试通过。

Windows 原失败场景修复后 **6/6**，再次与输入/env 套件合跑 **12/12**；真实 kernel 的能力拒绝/复用/恢复阶段测试 **3/3**。新回归进入三平台 helper gate；Linux/macOS 本轮无执行证据。这关闭的是测试编排缺口，不代表新增 Windows mutation crash 或 Desktop resume 保证。

### 下一段创建接线的已知约束

不能直接把 catalog 的 `session.create.v4` 请求指纹与底层 `maka-managed-session-create-v1` 指纹串接：前者绑定原始 workspace/model selector、labels 和 policy-default 语义；后者绑定解析后 cwd/connection/model 以及固定 `ask/direct/agent/default` Session 字段。两者目前不是同一个创建请求。尤其 default model 或 policy 改变后，重试不得静默创建另一份 baseline/Session。

接线顺序确定为：catalog admission 固定请求 → workspace/model/policy 授权并冻结完整 Session 输入 → 将唯一请求身份绑定 import intent、baseline 和 stable Session publication → continuity refresh → 返回 catalog item。首次失败保留原 attempt 身份；响应丢失后的重试必须先查原身份，不能先重新解析可变默认配置。现阶段继续关闭普通 `session.create` 的 managed profile 入口，不通过删除拒绝分支来宣称产品完成。

## 第二十七检查点：创建元数据纳入 import/Session 同一请求快照

managed 创建 owner 新增显式 `projectId`、`labels` 和 `thinkingLevel`，与 source/model/name 一起进入固定 Session 输入及原请求指纹；import intent 与 stable Session publication 使用同一 descriptor。不再静默丢弃这三类 catalog 元数据。本次没有宣称已统一原始 selector 与解析后 model 的两个创建协议。

- **Owner/权限**：这些是上层授权后交给内部创建 owner 的值，不是 project/model 授权能力。Host handler 仍未开放，普通 `session.create` 仍拒绝 managed profile。thinking level 使用 core vocabulary；labels 复用 catalog 数量/字节限制，拒绝重复、空值、保留执行模式标签。实际模型是否支持某 thinking level 仍由 model admission 负责。
- **冻结边界**：任务创建入队之前复制并冻结 labels，descriptor/publication 再保有独立冻结副本。调用者修改原数组不能改变待创建内容。project/labels/thinking 的任一变更进入不同指纹，不能借同 session ID 复用旧 import 或已发布 Session。
- **原子/失败/回滚**：仍为 Git import intent → SQLite baseline → Session publication，不伪装成跨系统事务。非法元数据在 import 前拒绝；半完成 import 的不同标签重试 fail closed；既有 Session 的不同项目/标签/thinking 重试拒绝。不增加 schema、协议版本或实验数据迁移。撤回新增调用字段不等价于原请求重试；已有 managed Session 应走 session-ID reopen，不改写身份。
- **证明**：先用真实 helper/child-process 场景复现创建后 projectId 丢失，再修复。子进程创建后退出、新进程重开保留元数据；import 后退出时改变标签被拒绝，原请求可继续。并发入队后修改调用方原数组仍持久化原值。加入非法项目、重复和超量标签，以及已发布后字段变化拒绝检查。

当前仍固定 `ask/direct/agent/default`，没有悄悄支持 Plan/Swarm/plugin 或通用 policy defaults。下一步需要在 catalog admission 中固定解析结果与原始 request identity 的关联，补默认模型/策略变化时的 durable retry，再接正式 handler；本检查点只是接线前的数据保真与身份保护，不是 Desktop 创建完成。

验证：Windows 本机 Host build、真实 helper/child-process 创建恢复 **5/5、0 skip**、CI gate policy **1/1**、Biome 和 diff check 通过。Linux/macOS 继续由同一 helper gate 调度，本轮未取得远程结果。仅覆盖命名进程退出边界，不扩大为任意指令点或断电保证。

## 第二十八检查点：创建与 catalog 读取共用字段合同

接线审计发现内部 descriptor 对 name/model/connection slug 一律允许 4096 bytes，项目与会话身份也没有使用 catalog entity-ID 语法。这会让内部成功创建的元数据超出公共 catalog 协议的读取能力。真实 helper 子进程测试先证明 321-byte 中文名称未被拒绝，再收紧创建边界。

- **Owner**：catalog 协议继续拥有字段语法和字节上限；managed 创建直接调用同一 decoder，不复制一套限额。内部额外的非空、NUL、保留标签检查继续生效。解码只验证形状，不授予 project/model 访问权限。
- **失败与原子边界**：排队前同步验证；不合格输入不进入 import/baseline/Session publication。Session、connection、project ID 使用公共 entity-ID 规则。name 为 320 bytes、model 为 512 bytes、connection slug 为 256 bytes；测试同时覆盖上限合法值和超限拒绝。
- **重试/回滚**：合法输入的 descriptor 和请求哈希不改变，不增加数据库 schema 或迁移。新边界不删除旧数据；已有任务仍走 session-ID reopen，不以重新创建来修复既有元数据。
- **平台证据**：使用原三平台真实 helper/进程退出恢复测试；Windows 本地验证，Linux/macOS 仅声明 CI 调度，不冒充本地实测。将 decoder 与 workspace 协议源码加入 helper gate 触发清单，避免公共规则变更漏跑创建测试。

本轮不是创建 handler 接通：默认 selector 到已解析输入的 durable 绑定尚未完成。下一步先确定复用现有 stable-create claim 的方式及 crash/retry 合同，再接 catalog admission、continuity refresh 和 Desktop 显式入口；不能通过去掉 managed-profile 拒绝分支跳过这条边界。

验证：Host build、创建恢复 5/5（0 skip）、CI gate policy 1/1、Biome、diff check 通过。相邻 catalog coordinator 全套为 53 pass / 2 fail：两个失败均在 Windows fixture 创建 symlink 时返回 EPERM，尚未进入业务断言；不修改权限、不跳过用例，也不宣称该全套通过。

## 第二十九检查点：prepared creation 与 stable claim 同一持久化 owner

### 本次落地

metadata schema **39 → 40**：只在现有 `session_create_claims` 增加可选 `prepared_header_json`，不另建创建日志，不改 RuntimeEvent schema。主线已存在的 39 不被改写；旧 claim 升级后字段为 NULL，不猜测历史默认值。新增字段有 JSON 有效性及 64 KiB 数据库约束。

`prepareStableSessionCreate` 在 `BEGIN IMMEDIATE` 内检查请求身份并首次写入已解析 header；同 Session 的主键与已有 request fingerprint 决定唯一归属。相同请求后续传入不同模型/配置，仍返回第一份快照；不同请求返回 conflict。`readPreparedStableSessionCreate` 允许上层在重新解析可变默认值**之前**读取原准备结果。快照尚未发布为 `session_metadata`，不进入 Session catalog。

stable publication 必须使用这份快照，而不是重试方重新提供的 header。所有 metadata insert 都经过同一 private writer：存在 prepared claim 时，普通 create/其他 insert 路径不能绕过 stable publication；返回给调用者的 header 只是独立解码副本，修改它不会改写数据库。prepared 路径暂不支持自定义 genesis boundary、conversation copy 或 subagent lifecycle，不能把这些独立的 authority 混入快照。

### 当前消费者与失败顺序

root-owned managed task 已在 fresh import 前消费 preparation。顺序为：验证 source；若 destination 已存在，先验证原 import intent 的请求归属；固定创建快照；必要时 import；接受 baseline；发布 Session。existing import 验证失败时不写入新 claim，防止错误重试先占住原请求身份。这一错误顺序由原有真实 helper 崩溃恢复测试暴露，修复后保持原断言，不把冲突消息改宽来遮掩。

- **原子边界**：claim 与快照同一个 SQLite transaction；Session publication 仍是后续 transaction；Git 与 SQLite 没有跨系统原子事务。
- **失败状态**：prepared-only、imported、baseline accepted、Session published 均按已有持久化证据继续。准备后出错保留同一身份，不重新选择模型，不静默 fallback。
- **回滚/取消**：当前不提供 prepared claim 的通用删除。generic discard 拒绝抹除它，避免失去既有 import 的请求身份；需要放弃时应使用新任务身份，自动 GC/显式取消协议不在本次承诺内。
- **范围限制**：任务 owner 当前仍使用解析后 descriptor 指纹；catalog 的 raw selector 指纹与它的关联还未接通。因此本次证明的是存储层“首次解析快照不被重试覆盖”，不是已经完成 default-model selector 的产品级重试。下一步 handler 必须先按 raw request identity 读取 preparation、重新验证授权，再从固定快照构造 import 身份，不能先解析新的默认模型。

### 证据与平台

Storage/SessionStore 相邻套件 **106/106**；真实 helper/root-owner 创建恢复 **6/6**（新增 prepared commit 后子进程直接退出、重新取得 root owner 后完成 import/publication）；另有独立 SQLite 子进程不 close 即退出后重开测试。覆盖 39→40 含旧 pending claim 的升级、错误请求冲突、返回值别名修改、普通 writer 绕过及 generic discard 拒绝。legacy rewind fixtures 同步移除新增字段后再降低版本，不为测试伪旧库放宽生产迁移。

Windows 本地执行通过；Linux/macOS 调度同一 helper workflow 与新增 prepared persistence step，尚无本轮远程执行结论。不声称覆盖任意指令点断电或完整跨进程竞争矩阵。内存测试 adapter 明确拒绝 prepared API，恢复测试使用真实 SQLite owner。

Desktop 正式入口仍关闭，不能把本次基础闭环描述为 Desktop managed task 已可用。没有新增自动恢复、扫描优化或第三种文件 checkpoint 模式。

## 第三十检查点：catalog 授权创建 → prepared snapshot → Gitoxide publication

四步产品接线中的**第 1 步**已接通服务端代码：`HostSessionCatalogCoordinator` 消费现有 Session admission gate、workspace resolver、connection/model 授权，先以原始请求指纹查 preparation，再按首次已解析快照发布 managed task。重试不重新选择 default model；仍重新验证固定模型当前是否启用、thinking level 是否允许，以及 workspace/project 是否仍匹配。

### Owner 与身份

- catalog owner 固定原始请求（进入异步操作前复制），复用 `session.create.v4` 的 workspace/model selector/name/labels/profile 身份。managed 默认权限明确规范为 `ask`，不用可变 runtime policy 默认值；实际创建固定 `direct/agent/default`，Plan、Swarm、Deep Research、plugin executor 和其他 permission 组合在写 claim 前拒绝。
- SQLite preparation 固定解析后的 Session header。root-owned `publishPreparedGitoxideManagedTaskInternal` 只接受 session ID、请求指纹和内部 helper 能力，自己从同 root 的 preparation 读取 source/model/metadata；不接受上层再传一份可替换的已解析字段。
- 原始请求指纹继续绑定 Git import intent 和 stable Session publication。standalone 内部创建仍使用原 descriptor 指纹，不假装两种调用身份可以互换。没有新 schema/协议 epoch；本次沿用 metadata 40。
- Host production composition 仅在安装已验证的 helper 时提供该创建 port；无 helper 的普通 Host 继续明确拒绝 managed profile。查询能力仍是提示，创建和重开仍逐次验证真实 authority。

### 事务、失败与回滚

Session admission → 原请求查 preparation → workspace/model 授权 → prepared claim → root-owned import/baseline → stable publication → continuity refresh → catalog result。SQLite 与 Git 依旧不是同一事务。相同请求恢复原快照，不同请求 conflict；原模型撤权时拒绝而不改选新默认模型。已经发布的请求只刷新 canonical catalog，不再次 import。

publication 或 refresh 的非预期失败保留原证据、返回 outcome unknown 并请求 Host drain，不执行 generic 创建或改写 mode。撤回本次 handler 接线只关闭新建路径，不删除 preparation/import/baseline/Session；既有 managed Session 仍需原恢复 owner。prepared claim 的显式取消/GC 仍未交付。

### 验证与范围

- real SQLite catalog 用例：首次 publication 中断，close/reopen 后 default model 改变，仍发布第一份模型；撤销第一份模型的 enabled 状态时拒绝，不能触达 publication；改变 name 的请求冲突；已发布重试不二次 import。模型/凭据端口使用确定性测试目录，不访问真实 provider。
- 真实 child process：运行 catalog handler、root lease、Gitoxide helper、SQLite；分别在 prepared commit 后、Session publication 后直接退出，新进程重新经过 handler 完成或读取原 Session。accepted Read 返回原 source 内容，baseline facts 不重复。continuity 的调用在 fixture 中被观察，不把它描述成完整 Host/Electron UI 测试。
- Windows 本机：创建恢复 **8/8、0 skip**，factory **4/4**，定向 catalog **2/2**，Host build、Biome、CI gate policy、diff check 通过。catalog 全套 **54 pass / 2 fail**，仍是两条 symlink fixture 的 EPERM，未改变权限或跳过。Linux/macOS 由同一 helper workflow 调度；尚未取得本轮远程结果。不承诺断电或任意 Git 指令点崩溃。

### 接下来仅剩的三步 Desktop 最小验收

2. Desktop 启动/复用支持 managed 的 Host：显式开发 helper 启动、能力要求与不可用提示；普通聊天不受影响。
3. 加号菜单 managed 文件任务入口：创建、发送、已有任务重开及“内容位于内部 accepted tree”的说明。
4. 真 Electron 创建 → Read/Write/Edit → kill Host → restart → 内容/transcript/唯一终态验证。

本次不表示 Desktop 已出现按钮，不表示 Glob/Grep、自动续跑、非 Git importer 或正式安装包 helper 发布已经完成。

## 第三十一检查点：Desktop 开发态 candidate 选择

第 2 步的启动选择已接入 Desktop：非 packaged、非 E2E 且显式设置 `MAKA_MANAGED_FILES_DEV_HELPER` 时，启动现有独立 dev candidate。该变量是 dev bootstrap 接受的完整 JSON manifest（schemaVersion、executablePath、expectedBytes、expectedSha256、platform、arch），不是 helper 路径，也不是发布签名。开发者必须明确选择文件并计算摘要；实际 admission 仍由 Host owner 在取得 root 后校验。空值或畸形值不静默退回普通 profile。

- owner：Desktop 只选择启动入口；Host 持有 helper admission 与真实执行能力。没有新增 durable 写入、schema 或 T1 协议。
- 默认未配置时继续普通 Host；E2E 使用自己的 fake-backend 入口；packaged 始终选择生产入口，不消费 dev manifest。
- 选举仍优先复用已有 Host，不强杀、不替换，也不对所有聊天添加 managed 能力要求。已有普通 Host 不会因此自动获得 managed 能力；后续入口必须查询实际连接的能力并在不可用时提示，而非宣称新配置已经生效。
- 回滚：撤回入口选择即可停止新 dev candidate 启动，不删除任何已创建任务或恢复证据。

Windows 本地：启动选择 5/5，Host factory（含真实 helper）4/4，连接配置 6/6，共 15/15；Biome 与 diff check 通过。Linux/macOS 的选择逻辑相同，但本轮没有实际 Electron 启动证据。重建 UI/computer-use 依赖后，Desktop build:main 仍被未修改文件的两处 TS7006 阻断：app-shell-pending-attachments.test.ts:66 与 session-ui-selectors.ts:44；不将本轮报告为全量构建通过。

第 2 步尚未完成能力提示/UI 接线；第 3 步加号入口和第 4 步真实 Electron kill/restart 验收仍待完成。当前仅证明入口选择与已有 helper admission 相容，不把 unit/factory 测试称为实际 Desktop 端到端测试。

## 第三十二检查点：Desktop managed 创建意图与 Host 能力检查

第 2 步的创建边界现已接通。此前 Desktop mapper 丢弃 `toolProfile`，显式 managed 请求可能变成普通创建；现在 Desktop IPC 只接受显式 `managed-files-v1` 或不指定 profile，拒绝未知和内部专用 profile，保留该字段交给 Host。进入异步 project resolution 前复制请求；client 在异步能力查询前再次固定发往 Host 的请求。

- owner：Desktop client 只做产品可用性预检；实际 profile、授权、prepared claim 与 publication 仍由 Host catalog/root owner 决定。能力查询不是可传递的执行授权。
- 原子边界：不增加持久化事务。managed 创建先查询同一 connection 的 execution capabilities，要求 epoch 匹配、ready、managedFilesResume=true，再调用原 session.create writer；Host 仍须在创建时重验，不能依赖先前查询消除竞态。
- 失败状态：不支持、draining 或错误 epoch 时不发送 session.create；不关闭或替换 resident Host，不转成普通任务。连接失败仍按现有错误处理，不把所有失败伪装成“不支持”。稳定的 unavailable 错误经 Electron 文本包装后映射为简中、繁中、英文提示，明确普通聊天仍可使用。
- 普通创建：不做 managed 查询，沿用原路径。撤回本接线不删除任务/claim/RuntimeEvent；不支持 managed 的 Host 不会因为 Desktop 启动而被自动升级。

验证：先确认 mapper 丢 profile、client 缺少查询、UI 只有通用错误三个 RED，再实现对应接线。Windows Desktop 主进程构建通过；client/catalog/提示/入口相邻测试 **52/52，0 skip**。包含 incapable Host 拒绝 managed 后继续普通创建、epoch/state 不匹配拒绝、查询等待期间 caller 改参数不影响固定请求。此处 client 测试用协议 connection double，不宣称是真实 Electron/Host 端到端证明；Linux/macOS 本轮未执行。没有新增恢复算法或平台文件系统承诺。

上轮两处 TS7006 已确认来自过期 TypeScript 增量缓存：同源 no-incremental 检查成功，使用仓库 clean:main 后 build:main 成功，没有通过类型断言或修改业务代码掩盖问题。

接下来是第 3 步加号菜单显式入口，再做第 4 步真实 Electron 创建与 kill/restart。当前没有可点击的新按钮，不能把 IPC 可用描述为用户已可使用整个产品流程。

## 第三十三检查点：加号菜单显式托管文件任务

第 3 步已接入 renderer：新任务的加号菜单在 Plan/编排选项旁提供“托管文件任务”（英文/简中/繁中）。只在新任务显示，不允许把已有会话原地转换。选中后显示 active mark 和说明：仅限 Git 项目，Read/Write/Edit 使用内部工作区、不直接修改 source checkout。选择按 Host/project 草稿保存，成功创建并激活后消费，不自动影响同一目标上的下一次新建。

- renderer owner 只表达创建意图；选中时清除 Plan/Swarm/Graph，固定 ask。发送 owner 再固定 managed-files-v1/agent/default/ask，避免其他草稿设置污染创建请求。未选中时原行为不变；不声明 Bash、Glob、Grep 可用。
- 实际产品链是 Composer → newTasks.create → session-local:create → SQLite 本地 creation intent → Desktop client → Host catalog，不是直接走旧 sessions:create。新增 local 入口预检当前 Host managed 能力；不支持/离线时不保存本地任务，返回可本地化的明确提示。队列真正向 Host 创建时仍重新检查能力，预检不替代 Host authority。
- 不新增 schema 或恢复终态；本地队列保存完整 toolProfile，Host 仍负责授权/import/publication，T1 和 accepted truth 不由 UI 决定。回滚入口只禁止新建，不清除已有本地 intent 或 managed Session。

Windows 验证：UI、Desktop main、renderer build（含 entry output 和 notices 检查）通过；菜单/首次发送/local queue/client 相邻测试 **86/86**，补充 local capable 创建保留 profile 与 Electron session-local 错误提示两项定向回归通过。菜单测试使用真实 React/DOM 组件，发送使用 bridge double；local queue 用真实 SQLite，但 capability 是测试端口。Linux/macOS 未在本轮执行，不声称真实 Electron 点选已验证。

剩余第 4 步：隔离用户数据的真实 Electron 创建 → Read/Write/Edit → kill Host → restart → 内容、transcript、唯一终态验收。开发态仍须显式 helper manifest；官方安装包尚不因本入口自动获得 helper。没有开启自动续跑、无 Git importer 或 M4/M5 能力。

## 第三十四检查点：真实 Desktop Write/Edit/Read 与 Windows 长路径

第 4 步的正常执行部分已经在 Windows 真实 Electron 窗口通过。新增手动验收脚本 `scripts/desktop-managed-files-smoke.mjs`，使用隔离 userData、真实 preload/main、选举出的 dev Host、SQLite 与 Gitoxide；不设置 MAKA_E2E、不安装 FakeBackend。唯一模型替身是本机 HTTP Anthropic 协议服务，依次要求真实 Write、Edit、Read，检查三个 tool result 成功、Read 返回 edited，且 source checkout 仍为 baseline。脚本实际点击加号菜单与发送按钮，不直接调用创建 handler。

### 本轮发现与修复

真实 Write 在 T1 后出现 candidate_publication_indeterminate。相同仓库、相同输入仅改变 candidate ref 长度：短 ref 成功，完整 64 字节 digest 的 ref 在 Windows 锁文件路径超过 MAX_PATH 后失败；使用 Windows extended-length 仓库地址则成功。Rust CLI 回归先复现该错误，再在 metadata admission 通过后将 Windows 仓库地址 canonicalize 为 extended-length path，供 gix 的 ref-lock rename 使用。没有缩短 digest、放宽元数据策略、重试工具或 generic T2 fallback。

- owner：Gitoxide helper 负责经过 admission 的仓库地址与 ref transaction；Runtime/T1/SQLite authority 不变。
- 原子边界仍是 Git ref publication，后续 acceptance 使用原有协议；本次不增加跨 Git/SQLite 事务。
- 失败仍 fail closed，已有 unsettled reservation 不由该修复自动清除。回滚代码不删除历史 ref、candidate 或 RuntimeEvent。

### 运行与证据

先构建当前分支 Desktop（包括 main、preload、renderer）与本平台 Gitoxide helper。使用仓库 release Node 24；系统 Git 仅用于创建隔离测试 source，不作为产品执行依赖。设置 MAKA_GITOXIDE_HELPER_PATH 为实际 helper 可执行文件的绝对路径，然后运行：

```text
node scripts/desktop-managed-files-smoke.mjs
```

脚本自行计算 dev manifest 摘要、创建本地测试模型配置，不读取用户模型凭据、不调用公网模型。运行会打开真实窗口；控制台给出证据目录，保留截图、main stderr 和本机模型请求。退出使用现有有界 Electron teardown。此脚本是手动产品验收，不声称已经加入 CI gate。

| 平台 | 本轮证据 |
| --- | --- |
| Windows | 真实 Electron 创建、Write/Edit/Read、source 不变通过；candidate 相关 helper 16/16，通过超过 MAX_PATH 的真实 CLI regression 与 exact retry |
| Linux | 未在本轮运行；路径修复不改变 Unix 分支 |
| macOS | 未在本轮运行；可使用同一脚本验证，不把可运行脚本视为通过证据 |

**仍未完成**：真实 Electron 中 kill Host/restart、恢复后 transcript/唯一终态和不重跑副作用的检查。本检查点只完成正常执行链，不宣称完整 Desktop Resume 已验收，不开启自动恢复、非 Git importer 或 M4/M5。

## 第三十五检查点：完成态 Host 强杀 → Desktop 重开

沿用第三十四检查点的真实窗口脚本，新增完成态故障步骤：Write/Edit/Read 返回且聊天显示完成后，读取本次隔离 root 的 Host registration，核对 root ID、ready、PID，并从 OS 查询该 PID 命令行，要求同时包含本次新建 workspace 绝对路径、root ID 与 expected-root-id 启动参数。只对这个 Host 发 SIGKILL，不枚举/批量终止其他 Host；随后关闭测试 Desktop，再用同一 userData 启动新 Desktop。

测试最初将 Host 假定为 Electron main 的直接子进程，保护性断言拒绝继续且没有发 kill。实际 Desktop 经 utility process 启动 Host，因此改为验证真实进程的隔离 root 启动身份，而不是依赖直接父子拓扑。没有削弱产品身份校验或修改生产 lifecycle。

重开后通过 UI 点击同一个任务，检查旧完成消息可见，再发送仅 Read 的新一轮。验证：

- 新 Host epoch 与被杀 Host 不同，root ID 相同；
- 模型历史保留原工具结果，新的 accepted Read 返回 edited；
- SQLite 中原 Write/Edit call/result 与 workspace successor 事件逐条保持相同，不能增加或改写；
- source checkout 仍是 baseline，未被恢复路径写回。

证据目录新增 reopened.png 与 restart-evidence.json，记录前后 epoch、原 mutation event IDs 和精确故障边界。SQLite 只读查询仅是验收 oracle，产品 UI/模型读取仍走真实 Host/transcript 链。脚本仍不使用 MAKA_E2E/FakeBackend，不访问用户数据和公网模型。

| 平台 | 本轮状态 |
| --- | --- |
| Windows | 真实 Electron/Host 强杀与重开通过；完成态 transcript、accepted Read、原修改事件不变 |
| Linux | 同脚本提供 ps 身份检查，尚未本轮实跑 |
| macOS | 同脚本可运行，尚未本轮实跑 |

本次只增加测试与文档，没有改变 writer、原子边界或恢复策略。失败保留证据，关闭流程仍有超时；回滚脚本不影响产品数据。**尚未证明** T1 后或 acceptance 后、模型收到结果前的执行中断恢复，也不证明自动 continuation、断电恢复或任意 process-tree kill。下一步应在真实模型请求/持久化边界设置可观察屏障，再验证中断任务的恢复，而不是把本次已完成任务重开当作自动 Resume 闭环。

## 第三十六检查点：中断任务实际恢复入口与剩余门控

真实 Desktop 新增 `--interrupt-turn` 场景：本机模型已收到 Write/Edit/Read 的三个结果，但最后的模型请求保持未响应；在此可观察屏障强杀隔离 Host、重启 Desktop、打开原任务并点击 Continue this turn。该屏障不依赖 sleep 或调度次数，也没有手工写 T1/T2。

首轮以“恢复成功”作为预期时真实失败：UI 明确返回 `resume_feature_disabled`。原因是 execution-composition 仅以 MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1 打开通用恢复，SessionManager 的两个 authoritative resume 入口均受其控制。当前开发 helper 能力只接通任务创建、accepted Read/Write/Edit，不等于已经接通 continuation。生产 safety inspector 当前仍读取 source cwd/marker，没有消费 managed accepted-head checkpoint。因此本次**没有打开全局开关**或把测试环境变量伪装成产品能力。

脚本现在对当前默认合同做明确的负向验收：

```text
node scripts/desktop-managed-files-smoke.mjs --interrupt-turn
```

它主动清除继承的 MAKA_RUNTIME_SAFE_BOUNDARY_RESUME，要求中断提示与禁用原因真实出现、没有新的模型请求、原 Write/Edit call/result/successor 逐条不变、source 内容不变。测试通过表示 fail-closed 有效，**绝不表示中断任务已经可以继续**。不带参数仍验证已完成任务强杀后的重开和 accepted Read。证据中记录两种不同 checkpoint。

### 接下来的实现顺序

1. 明确 managed continuation owner：从持久化 Session profile/binding 判定适用范围；不因某个 Host 有 helper 就对所有普通会话打开恢复。
2. 将 source Run 的 RuntimeEvent high-water、workspace epoch、accepted event/head 与实际工具 profile 绑定成恢复观察。不能直接把“此刻最新 head”当作被中断 Run 的 head；检测不匹配时 park。
3. 在同一恢复 claim/admission 中复验上述边界，再创建新 Run，消费已持久化工具结果，不走新消息/重新 Write/Edit 的替代路径。复用既有 claim owner，避免新增第二套 recovery ledger。
4. 用当前真实 Electron 屏障把负向断言提升为显式 Continue 成功；增加 accepted head 漂移的拒绝用例，再讨论默认开放。自动启动续跑、扫描优化仍不在本轮范围。

平台：Windows 本轮真实验证该中断/拒绝路径；Linux/macOS 尚未执行。没有新增生产代码、schema、协议版本或平台恢复承诺，也没有测试 T1 已写但工具尚未完成的崩溃窗口。

## 第三十七检查点：continuation safety 传递 Runtime 选定的 source 边界

现有 inspectContinuationSafety(sessionId) 无法区分普通新 Run 的 workspace identity 查询与恢复某个指定 source Run。直接在 Host 回调中查询“最新 head”不能证明它属于要恢复的历史。本次先扩展同一个 inspector seam：可选 source 参数包含 sourceRunId 和 expectedRuntimeEventHighWater，不增加第二个 planner 或第二套 claim。

- owner：SessionManager 读取指定 source invocation 后传入其 runId，并保留调用方要求的 high-water；规划输入在第一次 await 前复制。RuntimeKernel 使用规划产物的 sourceRunId/sourceRuntimeEventHighWater，在原有执行前及 backend activation barrier 内再次调用同一个 inspector。传递对象冻结，不能被 callback 改写。
- 普通新 Run 不带 source；local safety inspector 将 source 原样传给可选 readWorkspaceCheckpoint。现有普通 workspace inspector 不受影响，不强迫它实现 managed 语义。
- 原子边界不变：Runtime 的 immutable prefix、continuation claim 与 start writer 仍拥有原有事务；source 参数不是新 durable fact，也不是 accepted-head 证明或开放恢复的能力。
- 失败/回滚不变：inspection 抛错仍 park/fail-stop；工具目录或 workspace 漂移仍阻止 backend activation。撤回本参数传递不修改磁盘数据；没有 schema/protocol 升版。

先让真实 SessionManager 测试断言收到 sourceRunId，确认 RED（原实现只传 sessionId），再实现。补充 execution 两次复验的固定 high-water/冻结参数断言，以及 local inspector 转发到 checkpoint owner 的测试。Windows Runtime/Host build 通过；continuation/resume/handoff 定向 **32/32**，包含真实子进程 SIGKILL 后的 continuation claim/start/terminal prefix 修复测试。该 crash harness 使用原有测试 backend，不等同于 Gitoxide/真实 Desktop 中断恢复闭环。Linux/macOS 本轮未执行。

下一步仍是 Host managed accepted-head owner：消费这个 source 边界，验证 epoch、accepted event/tree 与 Runtime prefix 的因果对应，并在 activation 时重验。该校验尚未接入；全局恢复开关、Desktop 中断场景的默认拒绝维持不变。

## 第三十八检查点：source-bound accepted-head checkpoint

Gitoxide baseline owner 新增 inspectContinuation，复用同 execution-stores 的 workspace authority，不接受上层提供 head/blob/接受结论。读取当前 head/version/epoch 并要求无 active mutation reservation；读取 source Run 的有界 immutable prefix proof（16,384 events、32 MiB 总量、8 MiB 单条），再读取该 proof 固定的 prefix。已指定 high-water 必须精确相等，不允许静默截短或采用后来追加的事件。

当前 head 必须是 successor，其 outcome/dispatch/operation ID 确实出现在指定 session/source Run 的 prefix，且为成功工具结果；dispatch 的 workspace、epoch、repository、base accepted event 与 execution profile 必须匹配 accepted version。随后通过已有 reopen owner 验证 Git artifact、必要时修复 accepted-ref projection，最后重验 head/revision/tree/commit、prefix digest/high-water 和 reservation。任何缺失或漂移均拒绝，不重跑 mutation。

- **调用权限**：session-bound execution capability 只接收 sourceRunId/high-water。sessionId、workspaceKey、repository path、helper owner 和 ledger 来自已绑定记录。Host local safety inspector 的 readWorkspaceCheckpoint 已消费此入口；普通会话或没有 source 的新 Run 不走此校验。
- **原子边界**：这是有界观察与异步后的复验，不是跨 Git/SQLite 的原子快照或写锁。后续执行仍必须经过 Runtime activation 内的同一 inspector 和既有 continuation claim；本次没有宣称观察一旦签发就永久有效。
- **失败/回滚**：没有 active head、未结算 reservation、错误 source、high-water 不符、Git 对象失效或验证中漂移均 fail closed。读验证不删除数据；reopen 只按原协议修复 accepted ref，不改 accepted truth。撤回接线不影响已有工具结果。
- **保守范围**：只证明 source Run 自己包含当前 accepted mutation 的情况。baseline-only、read-only source 或仅通过祖先 lineage 持有该 head，目前拒绝；后续要补 durable read/lineage 证据，不以当前最新 head 猜测历史。

先通过真实 helper/SQLite 子进程 fixture 复现缺少 inspect owner 的 RED，再实现。正常 AiSdk Write/Edit/Read 后新进程校验通过；错误 Run、错误 Session、过期 high-water 拒绝；session-bound capability 返回相同 checkpoint。相邻 backend 在第一次 durable outcome 后直接退出的原恢复用例继续通过。Windows 执行；Linux/macOS 本轮未执行。不将这些 fixture 称为完整 Desktop Continue 验收。

恢复开关保持关闭。下一步是限定 managed profile 的启用策略与真实 Desktop Continue 正向验收，并补 source-bound head 之后发生推进时的拒绝证据；不打开所有普通会话的通用恢复开关，也不新增 schema/protocol。

## 第三十九检查点：限定 managed Resume 与真实 Continue 正向验收

恢复门控现在允许 Host 提供按 Session 求值的策略，而不只支持进程级 boolean。两个 authoritative 规划入口均先 await 同一策略。Host 在没有显式全局 opt-in 时，只对拥有 admitted managed helper、持久化 profile 为 managed-files-v1、没有 plugin executor 的 Session 放行；普通会话默认仍关闭。原有 MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1 显式 opt-in 保留，不由测试偷偷注入。

门控只允许进入规划，不是 workspace authority：仍必须经过上一检查点的 source-bound accepted checkpoint、Runtime prefix/claim，以及 activation 中的 safety 重验。没有新增 schema、claim 表或 T1 后 fallback。策略读取失败不会创建恢复 Run；checkpoint 证据不足或漂移仍 park。关闭门控可停止新的恢复规划，但不删除已提交结果或 continuation 历史。

真实 Windows Electron 的 `--interrupt-turn` 已从第三十六检查点的负向 gate 验收升级为正向流程：

```text
Write → Edit → Read → 模型带三个工具结果发起尚未完成的请求
→ SIGKILL 隔离 Host → 重启 Desktop → 点击 Continue this turn
→ 新 continuation Run → accepted Read → 模型结束
```

验收没有发送替代用户消息，没有开启全局恢复环境变量。新 Run 的 opening.source 为 continuation，绑定原 sourceRunId、claimId、high-water 和 boundaryDigest；总共两个 Run，而不是多个重试 Run。恢复后的模型历史包含原三个工具结果，新 Read 返回 edited，原 Write/Edit call/result/successor 逐条不变，source checkout 仍是 baseline。该流程本轮真实窗口两次通过（第二次包含新增 lineage 断言）。

| 平台 | 本轮证据 |
| --- | --- |
| Windows | 真实 Desktop/Host Continue 正向通过；Runtime/Host build 通过；Runtime continuation/resume/handoff 32/32（含 SIGKILL harness） |
| Linux | 未在本轮运行 |
| macOS | 未在本轮运行，可使用同一脚本，不视作已验证 |

Host 的 WorkHub disabled-resume 定向测试在清理临时 runtime.sqlite 时返回 EBUSY，本轮未改清理逻辑，不宣称该 Host suite 全绿。SessionManager 定向测试证明同一按 Session 策略允许指定任务、拒绝其他任务；原默认禁用测试继续通过。

当前仅承诺这条有证据的受限路径：本 Run 已完成产生当前 accepted head 的 mutation，随后在模型等待阶段中断，可由用户显式 Continue。尚未覆盖 mutation T1 已落盘但 outcome 尚未接受、baseline/read-only source、仅从祖先继承 head、多次中断 lineage、自动启动续跑和断电。下一步优先补 head 推进/证据失效的负向产品测试与 read-only/祖先边界，不把本检查点称作无限制 Resume 或 M3 全部完成。

## 第四十检查点：旧 Run 不能借用后来推进的 accepted head

新增真实 helper/SQLite 子进程回归：先读取原 AiSdk Write/Edit/Read Run 的有效 checkpoint，再通过真实 ToolRuntime、session-bound mutation owner 和 Gitoxide 在同一 workspace 的另一个 Run 提交 Write。原 Run 的 immutable events 与 high-water 保持完全不变。再次请求原 checkpoint 必须因 head 不属于 source Run 而拒绝；新的 Run 则可以取得不同 accepted ref 的 checkpoint，且拒绝旧恢复不回退或覆盖新内容。

这是既有 fail-closed 行为的补证，不修改生产状态机，不是完整 Electron 漂移 UI 测试。owner 仍是 source-bound checkpoint inspector；接受边界仍是已有 SQLite mutation transaction；拒绝观察不写 terminal、不重跑 Write/Edit、不删除任何历史。平台证据以本轮实际执行结果为准，不从 Windows 推断 macOS/Linux。

本轮 Windows：Runtime Host build 通过；backend-live-sequence（含新 head 漂移断言）和 backend-crash-first 共 2/2 通过、0 skip。Linux/macOS 未执行。本轮没有重跑 Electron，不将前一检查点的窗口验收当作本轮新增测试。

### Write/Edit Resume 剩余路线（不扩大到完整 coding agent）

| 顺序 | 工作 | 完成判据 |
| --- | --- | --- |
| 1 | 只读/祖先 head 的 continuation 边界 | source 未产生新 successor 时，仍能从 durable invocation/lineage 证明它使用的 head；禁止直接采用最新 head。首次只读任务和恢复后只读再中断都能继续，head 漂移仍拒绝 |
| 2 | 多次中断及重复 Continue | 两次以上真实 Host kill/restart；每次只有一个合法新 Run，既有 mutation 不重复，重复点击/并发 claim 不创建重复执行 |
| 3 | mutation 内部崩溃的产品恢复 | 从真实 Host 在 T1 后、candidate 后、acceptance 后分别退出；有接受证据的只 adopt，证据不足的明确 park，不能把 storage 子进程测试等同于 Desktop 闭环 |
| 4 | 可理解的 Desktop 拒绝与平台复跑 | head/profile/helper 漂移、active reservation、缺少证据时展示明确原因；macOS/Linux 运行同一真实 smoke，Windows 保留已有证据 |

以上是四个验收工作包，不是承诺四个 commit 就完成。第一项需要先核对已有 invocation/lineage 是否足够表达初始 accepted 边界；若不足，应在新 Run admission 记录它，不能猜测或从可变当前状态补造旧事实。

现有能力：成功 Write/Edit 已接受后，在等待模型期间中断，可以显式 Continue 并消费旧结果；源 checkout 不被修改。尚不能宣称任意 Write/Edit 中途都能自动恢复，也不能宣称只读任务、多轮反复中断已闭环。

不作为这一交付前置：自动启动恢复、扫描优化、Bash/npm/tests、Publish/Undo、非 Git importer、长期 GC。它们分别属于自动化体验、额外执行能力或 workspace 生命周期，不应为了“Write/Edit Resume 完整”无止境扩张本轮范围。源码 checkout 的交付/发布也不是恢复成功的隐含行为。

## 第四十一检查点：认证继承 head，并暴露第二次重启的 owner 缺口

source Run 自己没有当前 successor 时，checkpoint inspector 现在只允许通过已持久化的 continuation claim/start 继承：opening 必须与 store-owned claim 的 target/startEventId 完整匹配，复用 core 的 continuationStartEventMatchesClaim；从 claim 固定的祖先 segment 读取 immutable prefix，并比较固定 high-water 与 prefix digest。在该前缀中找到 accepted version 的原始 outcome/dispatch 后，仍执行原有 workspace/epoch/repository/base/profile 校验、Git reopen 和最终 source/head/reservation 复验。返回的 high-water 是本 source Run 的位置，不冒用祖先位置。

读取上限明确为最多 32 个祖先，每段 1,024 events / 1 MiB（单条也不超过 1 MiB）；原本的 source prefix 预算不变。超限、未认证 start、历史不符或 head 不在继承边界内都拒绝。此限制是 v1 保守产品边界，不宣称任意长历史都可恢复。首次 baseline-only/read-only fresh Run 仍拒绝，不以最新 head 补造入场事实。没有新增 schema 或第二套 lineage 表。

原子性与回滚：claim/start 的持久化仍由现有 SQLite authority 拥有，inspector 只是验证者，不提交新的接受事实。失败不回退 head、不删除历史、不执行 Write/Edit；撤回此 inspector 扩展只会重新拒绝继承场景。祖先 segment 是固定不可变前缀，恢复 activation 仍须重新校验当前 head。

真实 helper/SQLite fixture 先执行 AiSdk Write/Edit/Read，持久化 continuation claim/start 后子进程直接退出（不 close stores/lease）；独立进程重开并验证继承 ref 相同、source high-water 为新 Run 自己的位置。随后另一个 Run 推进 head，原 Run 和继承 Run 都必须拒绝恢复。该测试验证存储与 checkpoint seam，不冒充完整 Host 重启流程。

### 新增的真实 Desktop 反例（尚未通过）

`node scripts/desktop-managed-files-smoke.mjs --repeat-interrupt` 在第一次 Continue 后只执行 Read，再次在模型等待阶段 SIGKILL Host、重启，要求第二次 Continue 后历史保留且旧 mutation events 不变。它是显式手动回归，不加入默认 CI，当前仍失败，不能作为完成证据。

Windows 复现目录：`C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-JKEFnK`。第一次恢复成功，第二次不出现 Continue；SQLite 中 continuation Run 有 opening/Read，但没有重启修复 terminal。代码原因：recoverAgentRunsFromLedger 排除所有 claimOwnedUnsettledRunIds（包括已开始 provider 的 Run）；recoverContinuationClaimsBeforeProvider 又只为 claim_repair start 提交 terminal，runtime_admission start 直接跳过。两条 owner 路径均不收口，单独修继承 head 不能修复此现象。另一次尝试在首次窗口启动失败，未将其计作恢复边界失败。

下一步必须在 continuation claim owner 明确定义“runtime_admission 已开始、旧 Host 已死、target 未终结”的恢复状态。先验证 claim/start、工具 ledger 与已接受结果，再由唯一 owner 提交可恢复的 interrupted terminal；未结算副作用仍 park，不能 generic fallback、不能把全部未终结 Run 直接标成安全失败。随后重跑本脚本及现有 claim-only/start/terminal crash matrix。不应仅删除 generic repair 的排除条件。

平台：本轮真实 Desktop 反例及 fixture 在 Windows；Linux/macOS 未运行。连续多次 Desktop Resume 仍未闭环，首次只读、mutation 内部崩溃等前述剩余项不因本检查点自动完成。

验证：Runtime Host build、Biome、diff check 通过；backend-live-sequence（包含 claim/start 进程退出重开、继承与 head 漂移）及 backend-crash-first 共 2/2 通过。`--repeat-interrupt` 失败已保留为下一检查点验收，不宣称 Desktop 全绿。

## 第四十二检查点：已启动 continuation 的独占 Host 重启收口

第四十一检查点的反例本轮再次复现：第二次重启没有 Continue。根因不是按钮或 head 继承，而是 claim-only repair 与 generic Run repair 均有意跳过 live-provider continuation，缺少独占 Host 重启情况下的接管分支。

### Owner 与能力边界

新增 recoverInterruptedSessionsAfterHostRestart，只有 Host 在 execution recovery 阶段、尚未开放新执行时调用。入口通过 storage WeakMap 认证真实 interactive execution writer，并要求 session/agent-run/runtime-event 三个 stores 与 SessionManager 的依赖逐一同一引用；每次 facade 访问仍受 live root lease 保护。单纯 StrictRecoveryStores 结构、布尔开关或复制对象不能获得该权限。普通 best-effort/strict recovery 的 live-provider indeterminate 行为不变。

在原 continuation claim owner 中增加一个受限分支，不删除 generic repair 的排除规则：

1. start 必须通过共享的 continuationStartEventMatchesClaim 完整验证；已终结 target 不改写。
2. 仅 managed-files-v1、无 plugin executor 的 Session 进入；工具 resolver 必须无 corruption、无需 reconciliation，且所有 decision 均 completed。
3. source-bound safety inspector 必须证明 background operations settled、accepted checkpoint restored、有 ref，high-water 精确等于本 target 的 immutable events 数量。任何不可用或不匹配均保留未终结状态，不猜测副作用。
4. 异步检查后重新读取 target events，必须完全不变，然后通过既有 terminal writer 提交确定 ID 的 app_restarted failed terminal。该事件说明旧物理执行中断，不把已成功工具结果改成失败，也不重新执行工具。

原子边界仍是 terminal RuntimeEvent 的持久化；其余运行状态为投影。提交前失败不写终态；提交后崩溃由已有 terminal 事实收敛，重复启动不添加第二个 terminal。真正 Continue 仍重新规划、复验 head/prefix/profile 并取得新 claim；startup repair 本身不调用模型、不自动启动新 Run。撤回入口接线会恢复为保守 park，不回滚已存在事实。

### 真实产品验收

同一 `--repeat-interrupt` 脚本从 RED 转为通过：

```text
Write → Edit → Read → 模型等待 → kill Host
→ 重启 → Continue → Read → 模型等待 → kill Host
→ 重启 → Continue → Read → 完成
```

验证三个不同 Run、两条 sourceRunId 相接的 continuation lineage，每次只新增一个 Run，最终模型历史包含原工具结果与两次 Read；Write/Edit call/result/successor 逐条不变，用户 source checkout 仍是 baseline。首次通过证据：`C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-XmWDCW`。

完成格式化和重建后第二次复跑也通过：`C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-LbKNZc`。这两次通过不替代不同平台或未结算副作用场景的证据。

Runtime/Host build、格式检查通过；continuation/resume/handoff 定向 32/32，包括真实 SIGKILL claim/start/terminal harness，以及伪造 writer 入口拒绝。无独占 writer 的旧 crash harness 对 started target 仍要求不制造 terminal，继续通过。

| 平台 | 本轮证据与范围 |
| --- | --- |
| Windows | 真实 Electron 两次 Host kill/Continue 通过，限定已结算 Write/Edit 与之后的 Read |
| Linux | 本轮未运行，不外推 Windows 结果 |
| macOS | 本轮未运行，可用相同显式 smoke 参数复跑 |

尚未承诺：任意 mutation T1 中途崩溃自动收敛、首次只读 fresh Run、无限次/无限长度历史、启动自动续跑、断电。下一优先项是此新入口对未结算 mutation/漂移的真实重启负向验收，然后才扩展 mutation 内部窗口，不扩大到 Bash/npm 或自动扫描优化。

## 第四十三检查点：独占重启入口的 drift / 未结算 T1 反向验收

本轮只补测试，不放宽生产恢复策略。复用真实 Gitoxide/SQLite 子进程链，给 continuation target 建立真实 managed Session header，再由新进程实例化使用同一 genuine execution writer 的 SessionManager，调用实际 recoverInterruptedSessionsAfterHostRestart，不用结构 mock 冒充独占能力。

- **Head 漂移**：另一个 Run 通过真实 ToolRuntime 和 Gitoxide 正常接受新内容；旧 continuation 的 claim/start 仍完整。新进程连续执行两次启动恢复，必须均调用真实 source-bound inspector 并拒绝；target events 逐条不变、不增加 terminal、不创建执行，新 accepted 内容保持不变。
- **T1-only**：同一 continuation 用真实 ToolRuntime 提交 managed Write 的 call/dispatch/reservation；在真正 commitToolPrepared 返回后、transform 之前子进程直接退出（不 close stores/lease）。新进程验证确有一个带 managedMutation 的 T1、没有 function_response、一个 unsettled operation。两次启动恢复后事件和 unsettled 记录完全不变；甚至不进入 checkpoint inspector，证明 tool-ledger 守卫先拒绝，而非仅因已有 head 漂移碰巧失败。accepted 内容和用户 source checkout 均不被该 Write 改写。

此处 owner 是真实 root writer 下的 continuation claim recovery；没有新增状态写入或“无副作用”猜测，因此没有回滚动作。prepared reservation 保留意味着该任务仍需后续 reconciliation/人工处理，不把安全拒绝表述为 T1-only 自动恢复已经完成。

平台范围：本轮 Windows 执行真实 helper、SQLite、新进程重开、真实 SessionManager 恢复入口；不是 Electron 按钮层的反向测试。Linux/macOS 本轮未执行。子进程保留 20 秒单次 timeout；含多个独立进程的 backend-live-sequence 总预算改为 60 秒，其余用例仍为 30 秒，避免约 29 秒的正常测试贴着旧上限波动。

剩余优先级：下一步验证 candidate 已固化但尚未接受的窗口，明确是接受已有证据还是继续 park；随后才做 T1-only 的恢复策略。首次纯只读任务和三平台 Desktop 证据仍待补齐。自动恢复、Bash/npm、发布与 GC 不纳入本轮。

验证：Host build、Biome、diff check 通过；backend-live-sequence 与 backend-crash-first 定向 2/2 通过；增加精确 T1 形状断言后单独复跑 backend-live-sequence 1/1 通过。没有改生产代码，也没有本轮 Electron 反向验收或全量 CI 声明。

## 第四十四检查点：candidate-only 崩溃状态不能冒充 accepted outcome

在上一检查点真实 T1-only 状态上，另一个 fixture 子进程读取持久化 function_call 参数和 accepted base，通过生产纯转换函数及 Gitoxide candidate owner 固化候选物，然后在接受前直接退出（exit 89、不 close stores/lease）。没有调用 checkout Write/Edit，也没有提交 T2。独立恢复进程要求 candidate ref 已存在且指向合法 SHA-1，连续两次调用真实独占 Host recovery 后检查：

- target 的完整 RuntimeEvents 不变，仍无 function_response / terminal；
- unsettled operation 不变；
- candidate ref 字节不变，不删除、不接受、不移动为 accepted；
- accepted Read 仍返回之前已接受的内容，source checkout 不变；
- tool-ledger 守卫先拒绝，不进入 continuation checkpoint inspector。

这是分阶段制造真实持久化中间状态的 storage/runtime recovery 测试，**不是**在正常 Host 的 commitOutcome 内直接注入 kill，更不是 candidate-only 自动结算成功。此前 crash-after-candidate fixture 只证明 Git candidate 留存，不能代替这一条 continuation recovery 接线检查。

当前缺口明确为 mutation recovery owner，而不是继续修改 continuation planner：Git candidate 仅证明候选内容，原 Runtime 的完整 provider outcome 尚未被 SQLite 接受，进程内 candidate capability 也不能跨进程复用。仅发现 ref 就 synthesize success 会越权。

下一实现的最小合同应复用已有 authority：从未结算 T1 冻结参数/base/operation 身份，验证同一个 reservation；纯转换重算期望内容（不是执行工具 handler 或覆盖 checkout），重新验证已有 candidate 与该内容、base、policy 精确对应；由同一个 mutation owner 构造有明确恢复身份的结果，并使用既有 SQLite 原子接受入口提交 T2/successor/head/释放 reservation。任何证据不符仍 park；不能另设 accepted ledger、generic T2 fallback 或凭可变 source 文件猜测结果。候选物不存在的 T1-only 处理仍单独设计，不在这一检查点暗中生成并接受。

平台与验证：Windows Host build 通过，Biome/diff check 通过，定向 2/2（含 candidate-only 新进程恢复和原 backend-crash-first）通过。Linux/macOS 本轮未运行；没有生产代码变更、没有扩展自动恢复承诺。下一步应实现并证明上述窄 reconciliation owner，而不是继续只补同类 park 测试。

## 第四十五检查点：恢复验证不能创建缺失的 candidate

落地 reconciliation 的第一个必要原语：Rust helper 的 candidate 请求支持 `requireExisting: true`。该模式复用原有完整 candidate receipt/tree/blob 验证，但在候选 ref 不存在时返回稳定 `candidate_missing`，在任何 object/ref 写入之前停止。没有通过 Host 的“先检查文件存在、再调用 create”来模拟这一保证。普通创建请求保持原行为，验证模式不参与 candidate 身份摘要，因此同一已固化候选返回完全相同的证明。

Owner 是 Gitoxide helper；此步骤不提交 SQLite、不释放 reservation、不推进 accepted ref。失败没有新候选物需要回滚，缺少或不匹配的证据继续由上层 park。此原语本身不提供跨进程排他权限；调用方仍须持有真实 repository/root owner，后续接受仍须通过 SQLite 原子 writer。

真实 helper 回归覆盖：缺失候选被拒绝且 ref 不出现；普通创建后验证返回同一响应且 ref 字节不变；不同内容的验证被拒绝且 ref 不变。先观察到 `invalid_request` 的 RED，再加入实现。Windows repository admission 全套 63/63 通过，其中 candidate 相关 17/17；helper 使用静态 CRT 构建，子进程 PATH 清空。Linux/macOS 本轮未运行，不宣称跨平台新证据。

本轮尚未接入 Host verification-only capability，也未增加恢复 T2 writer 或自动结算。下一步按顺序接入：Host 验证入口 → 从持久 T1 重建 exact outcome → 原子接受与新进程重复恢复测试。T1-only 仍不得创建 candidate；Desktop 的现有已结算 Write/Edit Continue 能力不变。

## 第四十六检查点：Host 可以重新签发已有 candidate 的 owner-bound proof

新增内部 `verifyExistingGitoxideCandidateInternal`，与普通创建入口分开命名；两者共享验证和 capability 签发实现，验证入口固定要求 helper 的 `requireExisting`，调用方不能通过额外字段把它降级成创建。Host 同步识别稳定的 `candidate_missing` reason。调用开始即复制参数，防止异步验证期间调用方改变字符串字段后签出与请求不符的 proof。

Owner 仍是原 repository admission authority。必须持有匹配的 accepted repository capability 和 owner token；只有真实 helper 完整验证通过才签发新的内存 capability。恢复不复制原进程的 capability，不接受 caller 自报的 candidate proof。此步骤不写 RuntimeEvents/SQLite，不移动 accepted ref，不释放 reservation，失败也不降级为创建或 generic T2。

真实子进程测试改为消费验证入口：先在没有候选物时用新进程验证，必须返回 `candidate_missing`；另一进程发布 candidate 后直接退出；随后两个独立进程分别 reopen 并重新验证，输出相同证明内容，但能力由各自进程重新签发。冲突请求被拒绝，accepted content/ref 保持原值。同进程回归同时验证新 capability 与原 capability 内容一致、对象身份不同、错误 owner 被拒绝，并覆盖 no-change candidate。

平台范围：本轮仅 Windows，使用真实 Gitoxide helper、root owner、SQLite 和进程退出/reopen；不是 Desktop kill 后自动完成 T2 的验收。Linux/macOS 沿用同一测试代码，尚无本轮执行证据。下一步的 durable settlement 仍须从持久化 T1 冻结上下文重算结果、验证 reservation/base，使用已有原子接受 writer；不能把这一检查点描述成 candidate-only 自动恢复已经完成。

验证：Host build、Biome、diff check 通过；真实候选验证/新进程重开 2/2 通过；补充 no-change 后，候选结算、成功/失败/no-op/crash 与原子 T2 重试定向 11/11 通过，0 skip。没有运行全量 CI，也没有改变 Desktop 的恢复策略。

## 第四十七检查点：candidate-only 的内部原子恢复结算

`GitoxideWorkspaceBaselineOwner.recoverCandidate` 现在拥有窄恢复入口。调用者只提交 workspace/session/run/operation 身份和真实 accepted repository capability，不能提交结果、candidate 描述或 successor。独占 root writer 经既有 execution authority 认证；本轮没有把此入口接到会接收新任务的 Host，只在独占重启测试中调用。未来启动接线必须在 admission 之前完成，不能把“持有 writer”误当成“没有活跃执行”。

准备阶段有界读取 RuntimeEvents（16,384 条 / 32 MiB），用共享 tool-ledger scanner 检查因果与参数身份；只接受固定 managed pure-transform profile 的 Write/Edit T1，拒绝 recovery decision、缺失 reservation、已终结但没有 T2 的 Run、workspace/base 漂移。从 accepted tree 读取原始内容并运行纯转换，结果受 managed profile 大小限制；通过上一检查点的 verification-only 入口验证已有候选。不会执行工具 handler、写 checkout、生成缺失 candidate，也不解释 Bash 等副作用。

恢复 outcome 使用稳定的 `<operationId>_recovered_response` ID；内容来自纯转换，model projection 使用现有默认 canonical encoder。事件时间是已读持久前缀最大时间加一的逻辑恢复时间，不伪造原进程的 duration。此入口不尝试恢复任意自定义 `toModelOutput`；仅面向固定 managed files profile。

原子性边界没有另起一套：共享 candidate settlement verifier 再从 durable T1 验证结果和证据，由现有 `commitSuccessor` 原子提交 T2/successor/head/释放 reservation；no-change 用 `commitNoEffect` 原子提交成功 T2/terminal/释放 reservation，不推进 head。Git accepted-ref 仍是后续 reopen 的幂等投影。准备或验证失败不写新事实、不删除 candidate，reservation 保留；SQLite 事务失败整体回滚，禁止 generic T2 fallback。

已结算重试返回原 RuntimeEvent，校验对应历史 successor origin 或 no-change terminal 和 reservation 释放，不重算、重写 outcome，也不要求历史 successor 仍是当前 head。原进程正常提交的另一种 outcome 不由此入口冒充为恢复结果。

验收包含真实 ToolRuntime 提交 T1 后退出、独立进程留下 candidate、恢复进程原子接受后直接退出（不 close store）、新进程重开并读取相同唯一 T2；accepted Read 返回恢复内容，source checkout 不变。候选 ref 篡改必须拒绝，随后原负向恢复检查仍证明 T1/reservation 未变；T1-only 调用新入口返回 candidate_missing；no-change 证明没有 successor 且精确重试不重复提交。候选发布仍是分阶段 fixture，不宣称已覆盖正常 Host 每条机器指令的任意 kill 点。

平台矩阵：Windows 本轮真实 helper/SQLite/进程退出重开验证；Linux、macOS 本轮未执行。无断电承诺，无 Desktop 按钮层的新证据。剩余工作是启动 owner 在新任务 admission 前调用此结算入口，再进行真实 Electron candidate-window kill/restart/Continue 验收；自动重启继续执行、T1-only 重做、扫描优化和 Bash/npm 均未开启。

验证记录：先以未实现入口观察到真实新进程恢复测试 RED；实现后相关 3/3（恢复链、原 backend-crash-first、no-change）通过；补齐 profile/结果预算和候选篡改检查后重建并复跑最终恢复链/no-change 2/2，通过且 0 skip。Host build、Biome、diff check 通过，未宣称全量 CI 或三平台通过。

## 第四十八检查点：生产 Host 启动阶段消费候选恢复结算

`execution` 模块的启动恢复在 coordinator/interactions 准备后、SessionManager interrupted-session 修复前调用 managed candidate recovery；仍早于 Host Ready、新任务 admission 和 schedulers。只处理 recovery session 列表内的 `managed-files-v1`、无外部 executor 的任务，且必须已取得 admitted helper。没有 helper 时不发现系统 Git、不切换工具模式，也不改变既有未结算事实。

`recoverGitoxideManagedTaskCandidatesInternal` 持有真实 interactive write lease，从 durable Session header 校验模式，从 storage root 和 session ID 推导 repository path，不接受 caller 自报的 repository/workspace 路径。读取 prepared operation 后，仅尝试 Write/Edit reconcile；每次 reopen 都重新取得 repository capability，并在结算前重读 header。原子接受仍由第四十七检查点的 owner 和 SQLite writer 执行。本入口不暴露到 session tool capability 或 RPC。

失败分层：root lease、header/ledger 枚举等基础访问失败仍传播；单个候选证据不完整或验证失败不阻止其他会话启动，只保留原证据与 reservation，输出需 ledger reconciliation 的警告。不调用工具、不创建候选、不写 generic T2、不自动开始新的 Run。警告不是新的 durable parked fact：若提交响应丢失，后续仍以 ledger 为准，不能靠日志覆盖已提交结果。

新增真实子进程验收使用产品的 `createGitoxideManagedTaskInternal`（真实 header 与产品 repository 路径）、ToolRuntime、Gitoxide、SQLite 和完整 `createExecutionRuntimeHostComposition().recover()`。在真实 T1 之后分别直接退出；candidate 窗口通过测试适配器固化真实 candidate 后、原子接受前退出。新进程启动真实 composition 后验证唯一 T2、reservation 释放、accepted Read 为新内容；第二次启动事件逐条不变；用户 source checkout 始终不变。

反向验收：没有 helper 时仍能完成 composition recovery 且 prepared 事实不变；候选 ref 篡改时 Host 启动成功但 operation 保留，恢复合法 ref 后才可结算；T1-only 连续两次启动均不创造 outcome。这些用例禁止 backend factory 被调用，证明启动修复不会偷偷启动模型。

平台矩阵：Windows 本轮真实 Host composition/子进程/SQLite/Gitoxide 通过；Linux/macOS 未运行。不宣称已做真实 Electron UI kill 验收，也不承诺断电。此轮使用已经持有独占 root lease 的 production composition，但没有重测 IPC election/socket；candidate failpoint 是测试侧适配器，不是实际发布包中的任意机器指令 kill。

下一步：真实 Desktop 的 candidate-window Host kill → 重启 → 手动 Continue 验收，并验证 transcript 与模型恢复只读取已接受的同一结果。仍不引入启动自动续跑、T1-only 重做、扫描优化或 Bash/npm。

验证：新增真实 composition 用例先 RED（重启后 0 条 T2），接线后通过；含 helper 缺失/篡改/T1-only 的最终用例复跑通过。关联启动资源清理/可选 Store 故障等定向总计 4/4、0 skip；Host build、Biome、diff check 通过。无全量 CI 或其他平台通过声明。

## 第四十九检查点：真实 Electron 候选窗口恢复与 transcript/model 一致性

手工验收脚本新增 `--candidate-interrupt`：从真实 Desktop 加号入口创建任务并发送消息，观察真实 T1/reservation 后，用外部 SQLite writer lock 阻止 T2；等待真实 Gitoxide candidate ref 发布，核验 elected Host 命令行绑定隔离 workspace/root 后杀死该 Host。确认进程退出才释放锁，并再次断言 T2 尚未出现。测试不写业务数据、不自行构造 T1/T2、不安装 fake Runtime、不向产品加入环境变量 failpoint；本地 HTTP 服务仅替代模型响应。

重启走真实 Desktop/main/Host election 与第四十八检查点的启动恢复。脚本要求唯一的 `<operationId>_recovered_response` 和引用原 candidate 的唯一 successor，然后实际点击 Continue。新 Run 仅要求 accepted Read：模型 replay 内容必须等于恢复事件的 modelProjection；通过 preload 会话目录取得真实 scoped Session key，再调用生产 transcript API，要求原 Turn 中恰好一个恢复 tool_result，且内容精确等于 durable result。Continue 前后 mutation events 必须逐条不变，source checkout 仍为 baseline。恢复不重放 Write/Edit handler；纯转换重算与已有 candidate 验证仍由生产 owner 完成。

Windows 本轮完整通过证据目录：`C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-8kqfl4`，包含 candidate-before-kill、restart-evidence、recovered-transcript、model-requests 与截图。Host epoch 从 `5f62290a-bbc9-4e8e-9bf0-71063cb4289c` 更换为 `33d98dc5-3522-41e9-b59a-07cacb54213e`。前一次运行错误地将原始 UUID 传给 scoped Desktop API，已修正测试调用；不是通过绕过 API 或修改生产 reader 让断言通过。

**调度限制必须保留：此脚本尚不是稳定 CI gate。** 本轮另一次运行在持有写锁时未等到 candidate（目录 `maka-managed-electron-VpMvZZ`，10 秒超时）。外部 DB 锁可能阻塞候选生成前其他 Host 写入；不能将重跑成功解释为稳定性已经证明。脚本不静默重试、不跳过失败窗口，不加入默认 CI；后续需要独立、可观测的候选发布握手来稳定 kill 时机，不能靠增加 sleep 或扩大超时充当证明。

当前新增的 UI 崩溃窗口只覆盖首次 Write 的 candidate 已存在而 T2 未提交；不宣称覆盖 Edit/no-op 的所有窗口、任意机器指令崩溃或断电。Linux/macOS 本轮未运行。启动自动结算已有候选不等于自动续跑模型，用户仍需 Continue；T1-only 继续保留未结算状态，不创建缺失候选。下一步优先稳定候选窗口的验收编排并补 Edit 对称场景；自动续跑、扫描优化和 Bash/npm 不扩大到本轮。

原 `--interrupt-turn` 回归也通过（`maka-managed-electron-p3kcIQ`）：真实 Write/Edit/Read 已完成后杀 Host，重启并 Continue，原 mutation facts 不变。Runtime Host、Desktop main/resources 构建通过，脚本语法、Biome 与 diff check 通过。本轮仅改验收脚本和记录，没有生产代码变更。

## 第五十检查点：Edit 候选窗口的 Desktop 对称验收

新增手工命令 `node scripts/desktop-managed-files-smoke.mjs --candidate-edit-interrupt`。首个真实工具是 Edit，针对 accepted baseline 执行 `baseline → edited`；不是用 Write 的恢复结果冒充 Edit。测试在 T1/reservation 和重启后的 recovered response 两端均断言工具名称为 Edit，其他核验复用第四十九检查点：候选已存在且 T2 未提交、杀 elected Host、重启唯一结算、手动 Continue 后 accepted Read 返回 edited、模型 projection 与 Desktop transcript 和 durable result 一致、source checkout 不变。

Windows 两次显式独立运行均通过，证据分别位于 `C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-jTLQOC` 和 `C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-xEdw1U`。第一次 Host epoch 从 `eb5be33f-fefa-4326-89e9-e26bf291b27e` 变为 `914b0ef3-2fee-4ab9-be3b-c8e77e024ad3`，恢复 transcript 的 diff 精确为 baseline 到 edited。不是脚本失败后内部自动重试。

未解决事项不变：外部 SQLite 全局 writer lock 的编排仍可能阻塞候选生成前其他写入。源码确认 Host SQLite 使用同步连接并设置 5 秒 busy timeout，但目前尚未定位上一轮失败中具体被阻塞的写入，因此不能宣称已找到完整根因或已稳定测试；本轮 2/2 也不覆盖该问题。下一步需要捕获阻塞点或采用可观测的候选发布握手，保持超时显式失败，不将本脚本提升为 CI gate。

本轮仅改测试和文档；Linux/macOS 未运行，不新增断电保证、自动续跑、T1-only redo 或产品可用性声明。Write 与 Edit 的已发布 candidate 恢复已有 Windows Desktop 执行证据；no-op、失败/no-effect、缺失或损坏 candidate 的 Desktop 级矩阵及跨平台证据仍需补齐。

## 第五十一检查点：用可观测断点替代 SQLite 全局写锁编排

第四十九/五十检查点的外部 writer lock 已从候选窗口脚本删除。它会阻塞同一 DB 的所有写入，不能精确代表 candidate→T2 seam；旧超时的具体竞争写入仍未查明，本轮不把它误报为生产恢复 bug 已修复。新编排不再依赖这类竞争条件。

仅测试 launcher 在加载实际 Desktop 前，为匹配隔离 workspace 和 `--expected-root-id` 的 Host spawn 加入本机随机端口 debugger。产品 launcher、Runtime、Gitoxide、SQLite 均未改动；常规 smoke 和重启后的 Host 不开启此入口。端点/PID 通过隔离目录中的原子文件发布；测试连接 loopback debugger，按当前构建文件中唯一的 `return verified.authority.commitSuccessor` 语句设置断点。源码结构变化时测试明确失败，需要重新审视位置，不猜行号、不退回 sleep。

测试先设置断点再点击发送。收到实际 `Debugger.paused` 后必须匹配断点 ID 和 `acceptPublishedCandidate` frame，再用只读 SQLite connection 验证真实 T1、唯一 reservation、无 T2，验证 candidate ref 存在。断点位于 candidate settlement verifier 之后、SQLite 原子接受之前。确认暂停进程 PID 等于 elected Host registration，并核验原有 root/命令行约束后 SIGKILL；确认进程死亡才断开 debugger，随后按原真实 Desktop 重启/Continue 链验收。没有改 schema、写业务事实、伪造 candidate 或延迟整个 DB。

此证据证明的是**指定生产边界暂停后真实进程死亡与新进程恢复**，不是自然调度下的随机 kill、任意机器指令崩溃或断电。测试进程可控制 debugger 是显式的测试能力，不作为发布安全边界或生产 API。断点/连接均有 deadline，连接关闭会回收未完成请求，失败不静默重试。

平台矩阵：Windows 本轮实际运行 Write（`maka-managed-electron-ol92bv`）与 Edit（`maka-managed-electron-WbiHAh`）均通过，包含恢复 outcome/model/transcript 精确一致、唯一 successor、Continue 前后 mutation facts 不变及 source checkout 不变。Linux/macOS 本轮未运行，暂不加入默认 CI。后续仍需 no-op/失败及损坏证据的 Desktop 级矩阵；不因此引入自动续跑或扩大恢复策略。

最终补跑 Write（`maka-managed-electron-xp1iCn`）通过，本轮三次显式运行 3/3；最终脚本语法、Biome 和 diff check 通过。仅测试/launcher/文档改动，无需重新编译产品，不宣称全量 CI 或长期调度稳定性已证明。
