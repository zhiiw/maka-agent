# Resume 审计收口计划（2026-09）

## 工作基线与交付

修复来源为 fork 的 `5b3d702103f2dfcc66283f9a3829b0946cd3ad06`，隔离分支
`codex/resume-closure-audit-fixes`。该分支是验证工作台，不将整个旧 stack 作为
最新 main 的最终 PR。最终按下表的 owner 边界提取到最新 main 或明确的前置 PR。
原工作区的未提交改动不参与本轮。

| 工作项 | Owner / 主要不变量 | 当前状态 | 验收 |
| --- | --- | --- | --- |
| 基础文件任务可用性 | Host 在 Session 创建前证明 profile，M5 缺失不阻塞五种文件工具 | 已实现，定向测试通过；真实 Desktop/Host 验收待补 | 仅 Gitoxide 时可创建文件任务；完整 profile 缺能力仍拒绝 |
| active T1 收敛 | 原 operation 的 Runtime proof 与 workspace terminal 一致 | 已实现纯 Write/Edit；真实 Host 两个 crash 点通过 | T1 / candidate 后 kill，重启不重放外部副作用 |
| transcript 单一权威 | RuntimeEvent 决定 live、replay、历史页面 | 已遏止成功 T2 后生成矛盾失败结果；完整切换沿用上游 #4791 / #4879 | T2 后投影失败不得变成失败结果；历史与 active 切换一致 |
| 连续恢复策略 | accepted history 独立于 source；Stop 与无进展重启不得自动重跑 | 已关闭 Git/非 Git 内容漂移阻塞；多代恢复待实现 | source 前进后恢复；多代有进展恢复；Stop / 无进展 park |
| 有界在线读取 | workspace authority 在线读取不扫描全库历史 | 待实现 | 无关历史增长不导致单次 admission 全量 decode |
| 产品证据 | 真实 Host/worker、Desktop IPC 与 crash matrix | 文件 profile IPC、Linux Host T1/candidate crash 已通过；其余矩阵待补齐 | Git / 非 Git、多次 kill、平台显式结果 |

## 文件任务和完整 coding 任务

`managed-files-v2` 是独立的产品权限集合，不是旧协议兼容层，也不是 T1 后 fallback：

- Read / Glob / Grep 从 accepted tree 读取；Write / Edit 使用纯转换和原有 mutation authority。
- 不开放 Bash、ManagedNodeTest、ManagedNodeRun、ManagedNodeTransform，也不打开依赖 snapshot authority。
- Host 有 Gitoxide capability 才能宣布文件 profile；完整 `managed-coding-v2` 仍要求全部 command owners。
- Desktop 创建新 Session 时优先选择完整 profile，其次文件 profile；两者均不可用时明确拒绝。
- 没有传入 Host capability 查询结果时默认没有能力，不能靠本地默认值声明完整 coding 可用。
- 已持久化 Session 的 profile 不自动改变；恢复时原 profile 缺能力仍 fail closed。
- Host wire compatibility epoch 随能力集合变更提升；不是 SQLite schema 或 mutation protocol 升级。

| 平台 | 文件任务的权限条件 | 完整 command profile |
| --- | --- | --- |
| Linux | 已验证 Gitoxide helper；本轮真实 helper 测试使用 WSL | 仍须独立 Node / sandbox / shell authority |
| macOS | 同样的 Gitoxide admission；本轮未执行 macOS 产品测试 | 仍须全部 command authority |
| Windows | 不再要求 standalone Node 才能宣布文件能力；本轮 IPC/profile 测试通过 | 保持现有不可用行为，不伪称完整 loop 已验证 |

本轮没有放宽工具权限、外部副作用恢复、未知 outcome 或损坏证据的 fail-closed 合同。
没有把“定向测试通过”写成“无缝 Resume 已全部完成”。

## Source provenance 与 accepted history

初次导入和显式新 epoch/rebaseline 仍执行 source admission；已有 epoch 的 reopen
直接读取 durable source provenance，不重新导入非 Git 目录，也不要求 Git checkout
仍停在导入时的 HEAD。Continuation 校验内部 accepted ref/tree 与 SQLite 边界，
而不是把外部 checkout 的新提交当作 task 损坏。

没有放宽 source branch Publish 的独立校验，也没有允许静默修改用户 checkout。
当前 source 根路径仍需存在、可解析且保持相同的 Git/非 Git 分类；源目录彻底删除或
分类改变后的纯内部恢复需要另行持久化 source-kind 绑定，不能伪称本轮已支持。

真实 Linux helper 回归（WSL）：Git 新提交后 reopen、非 Git 内容变化后 reopen、
source 新提交后 continuation boundary 不变，以及既有 source-branch Publish、显式
rebaseline 共 5 项通过，无跳过。Windows/macOS 的这组真实 helper 证据尚未补齐。

## Prepared Write/Edit 的启动收敛

仅原 Run 仍为 `running`、原 T1 为已知 `write_edit_v2` 顶层纯转换 profile 时，
startup owner 才能恢复 active reservation。已取消、已终结、未知 profile 和命令操作
不经过这条路径。原始 call/dispatch 仍由 scanner 验证，重新 admission 必须逐字段
匹配原 T1；任何不一致保留 reservation 并 park，不把未知状态改成成功。
Code Mode/嵌套工具也暂不恢复：它们可能带额外的调用者结果预算，而该预算尚未写进 T1。
不能用固定 profile 的结果预算替代遗失的更严格限制。这不减少文件 profile 的生产工具集。

Runtime 根据 immutable accepted base 和原始参数重新计算纯函数结果；这不是再次调用
Write/Edit 文件系统工具。在线与恢复结果使用同一个 response builder，provider result、
error/no-op 分类和 durable envelope 保持一致。无法知道原工具耗时，所以恢复 event 不
伪造 duration；proof 中的零值仅用于恢复计算，不声称是原执行的测量值。

Owner 继续使用原有 candidate/SQLite terminal/accepted-ref 事务和幂等投影。启动顺序为：
已有 Run 检查 → 纯 mutation 收敛 → interrupted Run 终结修复 → continuation claim。
没有足够证据时仍 park，而不是盲目释放 reservation。

本轮证据：Runtime durable-boundary 最终 60/60；真实 Linux helper owner crash 2/2；
真实 Host + Runtime + SQLite/Git 的 `after_managed_t1` 和 `after_candidate_capture`
在 Git/非 Git source 上的杀进程/重启矩阵 4/4，均无跳过。Host 重启后自动创建
continuation，provider 只看到一次原始 Write 调用及其结果；崩溃期间用户修改 source
的字节被保留。测试的 source 与正在运行的 SQLite/storage root 分离，不能把不断写入
的 Runtime DB 当作稳定非 Git 快照输入。WSL 挂载目录模块加载较慢，这四个测试显式
使用 60 秒 startup budget、180 秒单项总时限，不修改生产 timeout。
专用 Gitoxide workflow 在 Linux/macOS/Windows 调度该文件，并新增 Runtime/profile
修改的 path selectors；CI planner 48/48 通过。配置会调度不代表远程 CI 已执行通过。
本轮没有 Windows/macOS 完整 Host crash 证据，也没有把无进展多代自动重启判为安全。

## T2 与 transcript publication

Durable attempt 现在显式拥有 committed 状态。T2 成功以后，transcript、SessionEvent 或
telemetry 发布异常属于 publication failure，不再进入工具业务异常处理，也不生成第二个
synthetic tool result。这个错误穿透 provider/Code Mode 的普通错误归一化，让当前执行
fail-stop；原 RuntimeEvent 成功事实保持不变，不能把它误报为 T2 提交失败。

这是完整单权威迁移前的安全遏止，不是自动补齐 `StoredMessage` 的实现。历史页面缺失的
通用重建、旧 JSONL 导入和 active/completed 统一读取由 #4879 交付，避免两个 importer。
在该前置合入之前，UI 仍可能暂时缺少那条记录；本轮没有承诺投影故障完全无感。
新增 transient transcript failure 和 telemetry failure 两项先 RED 后 GREEN，
Runtime durable-boundary 最终 60/60，通过结果仅证明这两个控制流不再制造矛盾事实。

## 剩余交付顺序（不是已完成功能）

1. **主线 transcript owner 对齐**：接入上游 [#4879](https://github.com/apache/maka/pull/4879)
   对 [#4791](https://github.com/apache/maka/issues/4791) 的单一事实源实现。先比较本分支
   mutation 的 exact T2 adoption 与上游 writer/reader 接口，再做最小适配。不复制一份
   legacy importer；主线与 fork 分别记录测试证据，不能拿 fork 的结果替代主线状态。
2. **有进展的多代 continuation**：保留现有 continuation 子 Run 的自动重启禁令，直到
   新 owner 可以从该子 Run 的 immutable prefix 和相应 accepted successor 证明“新进展”。
   不用新的 run id、更新时间、partial snapshot 或只前进的 high-water 冒充进展。
   自动恢复仍需同 epoch/profile、完整安全边界、唯一 claim；Stop、未知 provider dispatch
   和无新进展必须 park。验收包括：第一代完成新 Write 后再 kill 可产生第二代；仅发送
   provider 请求后反复 kill 不增加调用；Stop 后重启不复活；损坏 lineage 不自动继续。
3. **在线 workspace authority 读取**：当前 `readCanonicalWorkspaceAuthoritySync()`
   仍会全库读取 RuntimeEvents，再扫描 baseline/successor/tool ledger。本轮没有以
   “加个缓存”或“过滤掉不相关 JSON”假装解决，因为那可能漏掉畸形 lane、别名 identity
   或改变跨进程一致性。后续 owner 必须把全量审计/rebuild 与有界在线验证分开：以
   workspace/epoch 的索引定位不可变事实，精确读取 successor 引用的 call/dispatch/T2，
   用 transaction 内的 revision/checkpoint 验证投影新鲜度；projection 不是独立真相。
   验收需证明无关 session 历史增加时 decode 数量不变、跨进程写入后不可复用旧校验、
   projection 缺失可 rebuild、被篡改的引用仍 fail closed，再做性能对照。
4. **产品/平台补证**：文件 profile 的 Desktop IPC 与 Linux 真 Host 测试不是完整 GUI
   自动化，更不是 Windows/macOS 已通过。后续运行各平台真实 helper + Host matrix，
   再从真正 Desktop 界面测试创建任务、强杀/重启、轻量恢复状态、park 和 Publish。
   Windows 完整 command profile 尚不可用，不将它列为此轮文件恢复的前置条件。

交付以这几组本地提交为提取单元；在上游/前置 PR 的实际新基线重建后再提交 review。
不推送整个旧 integration history，也不把这些修复描述成 M3/M4/M5 全部完成。
