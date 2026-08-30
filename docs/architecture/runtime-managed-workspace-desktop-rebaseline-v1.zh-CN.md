# Desktop Managed Workspace Rebaseline v1

## 主要不变量

Desktop 的 Rebaseline 不会原地替换旧 workspace epoch。用户显式选择“从最新源代码创建新基线”后，Runtime Host
先创建并验证一个 dormant epoch，再通过 active-epoch authority 原子切换当前 epoch。旧 epoch、accepted history、
restore point 与 continuation evidence 全部保留。

普通 Desktop reopen 不接受 UI 缓存中的 epoch identity，而是从 immutable activation facts 重建 active epoch 后再打开
对应 Gitoxide repository。相同 `rebaselineId` 是 exact retry；不会重复创建 causal transition。

## Owner 与原子边界

- Desktop 只签发稳定 `rebaselineId` 并呈现结果，不拥有 epoch identity。
- Runtime Host session owner 重新观察 source、创建 baseline，并签发 owner-bound activation proof。
- SQLite workspace authority 在一个事务中提交 activation RuntimeEvent 与 active-epoch projection CAS。
- Gitoxide repository/baseline 已创建但 activation 未提交时只是 dormant artifact，不改变当前任务世界。

## 失败与恢复

| 失败点 | durable 结果 | 恢复 |
| --- | --- | --- |
| source admission/import 失败 | 旧 active epoch 不变 | 修正 source 后使用同一 ID 重试 |
| dormant baseline 已提交、activation 前退出 | 新 epoch 可验证但未激活 | exact retry 补 activation |
| activation 事务内退出 | 整个 activation 回滚 | 普通 reopen 仍打开旧 epoch |
| activation 已提交、响应丢失 | 新 epoch 已是唯一 active | 普通 reopen 打开新 epoch；同 ID 重试返回同一结果 |

真实 Runtime Host 子进程在 activation commit 后退出的测试证明最后一种状态不会回退或重复 rebaseline。

## 平台矩阵

Linux、macOS、Windows 使用相同 RuntimeEvent/SQLite active-epoch identity。source path 先 canonicalize；v1 承诺进程
崩溃收敛，不声明硬件断电持久性。Windows 文件占用可能保留 dormant Git artifact，但不得改变 active epoch truth；长期
回收归 M4 GC owner。

## 产品范围

Review 面板在正常状态提供显式 Rebaseline；若 accepted review 因 source drift 无法打开，错误状态仍提供该入口。成功后
面板重新读取新 active epoch。v1 不自动 rebaseline，也不会在后台静默改变任务的 causal universe。
