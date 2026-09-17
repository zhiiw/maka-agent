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
