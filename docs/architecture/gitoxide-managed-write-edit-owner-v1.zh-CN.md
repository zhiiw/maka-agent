# Gitoxide managed Write/Edit owner v1

## 主要不变量

一次 managed Write/Edit 在 T1 前绑定 durable workspace epoch、canonical head、单一路径和固定执行
profile。T1 后只能收敛到以下三类 durable 结果之一：

- 无变化或已证明无副作用的失败，由 SQLite 原子提交 terminal T2 并释放 reservation；
- exact result 被固化为 operation-bound Gitoxide candidate，由 SQLite 原子提交 T2、successor 和
  canonical head，再将 `refs/maka/accepted` CAS 到该 candidate；
- 证据不完整或状态无法确定时保持 unsettled，禁止 generic T2、fallback 和工具副作用重放。

## Owner 与权限

- Runtime 独占原始 Write/Edit 参数和 provider result。Host 只能读取 Runtime-issued immutable
  operation proof，不能返回或替换 provider result。
- Execution Stores authority 从 durable epoch 读取 `workspaceInstanceId`。调用者不能自报 reservation
  identity。
- Gitoxide repository authority 只从 exact accepted commit/tree 读取 base content；Write/Edit 是
  `F(immutable base, Runtime-owned args)` 的纯变换，不读写 live checkout。
- Candidate receipt authority 拥有 candidate ref、receipt 和 exact retry。
- SQLite workspace authority 是 accepted truth owner。只有成功的 successor transaction 才签发
  owner-bound projection capability。
- Gitoxide helper 只消费该 capability 做 accepted-ref CAS；裸路径、OID、receipt 或 caller object 都不能
  推进 accepted ref。

## 原子性与恢复边界

Git ref 与 SQLite 无法组成一个物理事务，因此 v1 采用两个有序线性化点：

1. SQLite transaction 提交 tool outcome、workspace successor、head CAS，并释放 T1 reservation；
2. Gitoxide helper 将 accepted ref 从 exact base CAS 到 exact candidate。

进程若死在两者之间，新 owner 按 operation ID 从 `tool_operations` 主键和 RuntimeEvent event ID 读取
exact call、dispatch、outcome。该读取是有界主键查询，不需要 schema 15 表达式索引，也不扫描完整账本。
恢复先区分 T1 是否仍处于 active：

- active reservation 表示 T2 尚未被 accepted truth 接受；projection owner 返回
  `gitoxide_managed_mutation_replay_required`，由 continuation/runtime 使用同一 durable operation
  重新进入纯 transform，绝不能报告 `already_current`；
- reservation 已释放且 durable successor 存在，表示 T2 已经接受；此时 projection owner 禁止重新计算
  transform，只允许采用已有 candidate receipt。

后者的恢复步骤是：

1. 以 durable parent head 重开 accepted repository；
2. 严格验证 immutable call/dispatch/outcome 与 durable successor 的 operation、path、parent 身份；
3. 直接重开 operation-bound candidate receipt，并把 receipt 中的 candidate commit/tree 与 durable
   successor 精确比较；
4. exact-replay 已提交的 SQLite successor，以重新签发 process-local projection capability；
5. 重放 accepted-ref CAS。

post-T2 恢复既不会调用普通工具实现，也不会再次调用 pure transform/candidate creation。pre-T2 的
deterministic transform 可以由同一 durable operation 重新计算，但最多只能有一个 successor 被 SQLite
接受。

## 失败状态与回滚

| 状态 | 行为 |
| --- | --- |
| T1 前路径、epoch、head、version 或 helper admission 不匹配 | 拒绝进入 T1 |
| T1 后 Runtime 证明 no-change/no-effect failure | 原子 terminal T2，释放 reservation，不推进 head |
| candidate/receipt 与 base、path、content 或 profile 不匹配 | unsettled；保留 reservation 或 accepted truth，禁止覆盖 |
| SQLite successor 未提交 | 不签发 projection capability，candidate 只是未接受 artifact |
| active reservation 仍存在 | 返回 replay-required；禁止把 current ref 误报为已收敛 |
| SQLite successor 已提交、accepted ref 仍为 base | 从 durable receipt 重开 proof 并重放 CAS，不重算 transform |
| accepted-ref observation 超时、取消或数据损坏 | 原错误 fail closed；只有 exact target mismatch 才允许进入 parent/candidate recovery |
| accepted ref 已为 candidate | exact replay success |
| accepted ref 为第三值或 durable evidence 不一致 | fail closed，不 reset、不自动覆盖 |

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | short-lived Gitoxide helper、SQLite crash convergence、exact candidate/ref replay |
| macOS | 与 Linux 相同的进程崩溃合同；不承诺 `fsync` 之外的断电语义 |
| Windows | 相同的 SQLite/ref 协议；successor-commit 后的子进程 exit/reopen 已进入三平台 Gitoxide helper workflow |

三平台均不依赖 system Git、bundled Git CLI、linked worktree rotation 或 live checkout 写权限。

## 当前交付边界

本切片提供 owner 与真实 helper/SQLite 合同测试，但尚不自行创建 Desktop/CLI managed coding session。
产品组合与 continuation 分别属于后续交付；它们只能消费这里签发的窄 capability，不能重新开放裸路径或
caller-provided execution profile。
