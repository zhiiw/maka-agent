# Resume 审计收口计划（2026-09）

## 工作基线与交付

修复来源为 fork 的 `5b3d702103f2dfcc66283f9a3829b0946cd3ad06`，隔离分支
`codex/resume-closure-audit-fixes`。该分支是验证工作台，不将整个旧 stack 作为
最新 main 的最终 PR。最终按下表的 owner 边界提取到最新 main 或明确的前置 PR。
原工作区的未提交改动不参与本轮。

| 工作项 | Owner / 主要不变量 | 当前状态 | 验收 |
| --- | --- | --- | --- |
| 基础文件任务可用性 | Host 在 Session 创建前证明 profile，M5 缺失不阻塞五种文件工具 | 已实现，定向测试通过；真实 Desktop/Host 验收待补 | 仅 Gitoxide 时可创建文件任务；完整 profile 缺能力仍拒绝 |
| active T1 收敛 | 原 operation 的 Runtime proof 与 workspace terminal 一致 | 待实现 | T1 / candidate 后 kill，重启不重放外部副作用 |
| transcript 单一权威 | RuntimeEvent 决定 live、replay、历史页面 | 沿用上游 #4791 / #4879，不平行重写 importer | T2 后投影失败不得变成失败结果；历史与 active 切换一致 |
| 连续恢复策略 | accepted history 独立于 source；Stop 与无进展重启不得自动重跑 | 待实现 | source 前进后恢复；多代有进展恢复；Stop / 无进展 park |
| 有界在线读取 | workspace authority 在线读取不扫描全库历史 | 待实现 | 无关历史增长不导致单次 admission 全量 decode |
| 产品证据 | 真实 Host/worker、Desktop IPC 与 crash matrix | 待补齐 | Git / 非 Git、多次 kill、平台显式结果 |

## 文件任务和完整 coding 任务

`managed-files-v2` 是独立的产品权限集合，不是旧协议兼容层，也不是 T1 后 fallback：

- Read / Glob / Grep 从 accepted tree 读取；Write / Edit 使用纯转换和原有 mutation authority。
- 不开放 Bash、ManagedNodeTest、ManagedNodeRun、ManagedNodeTransform，也不打开依赖 snapshot authority。
- Host 有 Gitoxide capability 才能宣布文件 profile；完整 `managed-coding-v2` 仍要求全部 command owners。
- Desktop 创建新 Session 时优先选择完整 profile，其次文件 profile；两者均不可用时明确拒绝。
- 已持久化 Session 的 profile 不自动改变；恢复时原 profile 缺能力仍 fail closed。
- Host wire compatibility epoch 随能力集合变更提升；不是 SQLite schema 或 mutation protocol 升级。

| 平台 | 文件任务的权限条件 | 完整 command profile |
| --- | --- | --- |
| Linux | 已验证 Gitoxide helper；本轮真实 helper 测试使用 WSL | 仍须独立 Node / sandbox / shell authority |
| macOS | 同样的 Gitoxide admission；本轮未执行 macOS 产品测试 | 仍须全部 command authority |
| Windows | 不再要求 standalone Node 才能宣布文件能力；本轮 IPC/profile 测试通过 | 保持现有不可用行为，不伪称完整 loop 已验证 |

本轮没有放宽工具权限、外部副作用恢复、未知 outcome 或损坏证据的 fail-closed 合同。
没有把“定向测试通过”写成“无缝 Resume 已全部完成”。
