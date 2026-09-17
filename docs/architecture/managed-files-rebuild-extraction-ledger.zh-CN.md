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
