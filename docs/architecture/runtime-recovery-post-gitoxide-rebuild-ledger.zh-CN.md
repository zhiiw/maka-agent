# #3741 / #3857 之后的恢复栈重建账本

## 1. 基线与目的

本账本以以下两个已经进入 `main` 的能力为前提：

- `runtime-managed-workspace-mutation-lifecycle-authority-v1`：T1 reservation、四态 terminal settlement、SQLite successor/head 原子提交；
- `gitoxide-accepted-tree-data-plane-v1`：受权 source import、accepted tree 直接读取、operation-bound candidate 生成与完整 candidate proof。

旧 fork PR #15–#29 是在更早的 API、Git CLI/旧 Gitoxide 协议和长期堆叠分支上形成的。它们只能作为设计、测试和故障样本来源，不能整体 cherry-pick。最终交付必须从最新 `main` 平铺重建。

## 2. 先固定的权限边界

managed Write/Edit 的 provider 参数归 Runtime 所有。Host admission 不得返回或改写完整 `executionArgs`。

当前基线采用更窄的合同：

1. Runtime 保存并快照原始 `content`、`old_string`、`new_string` 等参数；
2. Host 只能通过 T1 `managedMutation.expectedPath` 绑定单一路径；
3. Runtime 在 T1 前要求 `expectedPath` 与持久化 function call 的 path 完全一致；
4. Host 只获得 Runtime-owned operation proof，不获得 provider result 或参数改写权；
5. Host 即使在运行时对象上夹带旧式 `executionArgs`，Runtime 也不得读取。

因此旧 PR 中“Host 返回 canonicalPath + 整套 executionArgs”的接口不得迁移。路径规范化必须在 durable call 身份冻结前完成；T1 后不能再把等价路径转换当作参数改写。

## 3. PR extraction ledger

| 旧 PR | 旧能力 | 新基线判断 | 可复用内容 | 处理方式 |
| --- | --- | --- | --- | --- |
| #15 | workspace successor authority | 已被 #3741 取代 | corruption、CAS、rebuild、exact retry 测试意图 | 删除旧生产实现；保留缺口清单用于等价性复核 |
| #16 | durable mutation reservation | 已被 #3741 取代 | 多进程竞争、kill/reopen、prepared T1 阻塞新 owner | 不迁移代码；核对新 recovery inventory 覆盖 |
| #17 | Runtime managed settlement | 已被 #3741 取代 | generic T2 禁止、线性 operation、strict JSON snapshot、结果唯一来源 | 不迁移代码；补权限收窄恶意 Host 回归 |
| #18 | Gitoxide candidate ref | 已被 #3857 取代 | exact-base、完整 tree、direct-ref、ref CAS 用例 | 不迁移代码 |
| #19 | filesystem projection | #3857 明确未包含 | projection crash/tamper 场景 | 重新定义独立 projection owner；不阻塞 accepted-tree Write/Edit |
| #20 | managed npm producer | 与 #3741/#3857 正交 | process-tree 回收、soft quota、lockfile 路径策略测试 | 从最新 main 独立重建，先复核当前 Node/permission 合同 |
| #21 | npm runtime attestation | 与 #20 成对 | manifest、packaging、真实 `.bin` 安装测试 | 与 #20 组成一个受权 producer 交付；不得迁移旧 release 假设 |
| #22 | packaged Gitoxide helper authority | 仍需要 | release resource identity、notice、三平台 packaging 测试 | 基于已合并 helper v2 协议重写；不复用旧 manifest 形状 |
| #23 | accepted-tree file read | 已被 #3857 取代 | blob identity、projection-independent read 测试 | 不迁移代码 |
| #24 | product composition / inspect | 仍需要 | packaged resource consumption、显式 unavailable 行为 | 待 #22 后重写；不得通过 PATH 或 caller path 自授权 |
| #25 | durable mutation candidate receipt | 仍需要，但旧 API 失效 | receipt 字段、orphan ref、retry/reopen、storage-root owner 测试 | 基于 #3857 candidate capability 重写最小 durable proof owner |
| #26 | Write/Edit acceptance | 仍需要，必须重写 | pure transform、四态 settlement、real Host/worker crash 场景 | 基于 #3741 + #3857 + 新 #25 重建；禁止整体搬运 20k 行堆栈 |
| #27 | continuation claim 绑定 workspace head | 仍需要 | exact head/profile claim、SQLite crash 用例 | 在 Write/Edit accepted head 闭环后重写 |
| #28 | managed continuation admission | 仍需要 | safe-boundary/head replay 校验 | 基于新的 accepted capability 和 session owner 重写 |
| #29 | continuation crash proof | 仍需要 | provider-once、park/retry、Host kill/reopen fixture | 只迁移 production-shaped 场景，不迁移旧组合代码 |

## 4. 新交付顺序

### R0：managed argument authority regression

主要不变量：Host 不能改写 Runtime-owned Write/Edit 非路径参数。

- owner：Runtime；
- 原子边界：durable function call/T1 之前；
- 失败状态：admission path 与 durable call 不一致时拒绝进入 T1；
- 回滚：未产生 T1，无需恢复。

### R1：durable Gitoxide candidate proof owner

主要不变量：一个 process-local candidate capability 只有在持久化为可从 Git artifact 重新验证的 receipt 后，才能跨 Host 生命周期进入 successor acceptance。

- owner：持有 storage-root write lease 的 Runtime Host owner；
- 原子边界：candidate ref 可先于 receipt 出现，receipt publication 是 durable proof 的提交点；
- 失败状态：ref-only、receipt-only、receipt/ref mismatch、helper/policy mismatch；
- 回滚：未接受 candidate 可删除或标记 orphan；已接受 truth 不由 GC 改写。

R1 必须直接消费 #3857 的 accepted/candidate capability，不能重新开放裸 repository path、ref 或 OID writer。

### R2：Write/Edit pure transform 与 candidate acceptance

主要不变量：

```text
exact accepted base + Runtime-owned args
  -> one immutable result blob
  -> one operation-bound candidate proof
  -> one #3741 successor/terminal transaction
```

- owner：Runtime 拥有参数和 provider result；Gitoxide owner 拥有 candidate proof；SQLite owner 决定 accepted truth；
- 原子边界：T1 reservation 与 terminal SQLite transaction；
- 失败状态：successor committed、no change committed、failed/no effect committed、unsettled；
- 回滚：T1 后禁止 generic T2 和直接重跑副作用。

首版继续使用“pure transform + immutable Git tree”，不恢复对 live worktree 的 Write/Edit 权限。

### R3：projection owner

主要不变量：projection 只物化 accepted head，不能成为 accepted truth，也不能影响 direct tree read。

- owner：独立 projection service；
- 原子边界：带 intent 的 fresh-directory publication；
- 失败状态：missing、staging、published-but-unverified、quarantined；
- 回滚：删除可重建 staging；外部漂移整体 quarantine。

projection 不与 R2 同 PR；#3857 已经证明无 projection 的 canonical read 可成立。

### R4：packaged helper 与 managed npm composition

Gitoxide helper 与 npm producer 分别保留自己的 trust root。packaged Host 只消费父进程/发布 owner 已验证的 capability，不接受 PATH discovery、公开路径参数或相邻自签 manifest 作为 authority。

### R5：workspace-bound continuation

只有 R2 产生真实 accepted successor 后，continuation 才能绑定 exact workspace head。R5 依次重建旧 #27、#28、#29 的 claim、admission 和 crash proof。

## 5. 测试迁移纪律

1. 先把旧测试转写为面向新 public/internal owner seam 的 RED 测试；
2. 不复制旧 fake 所假设的绝对路径、Git CLI 或 projection 行为；
3. process-crash 用例必须由 child process 直接退出，再由新进程 reopen；
4. Linux、macOS、Windows 的承诺分别写入 recovery inventory；未进入 CI 的平台标记为未验证；
5. `git range-diff` 只用于证明“旧设计意图是否被覆盖”，不能作为代码等价证明；
6. 每个最终 PR 从当时最新 `main` 建立，路径级 diff 只包含该交付的 owner 和测试。

## 6. 明确删除或延期的旧假设

- 删除 Git CLI/linked-worktree rotation 作为 canonical mutation data plane 的旧路线；
- 删除 Host 可返回完整 execution args 的接口；
- 删除 candidate receipt 对旧 capability/protocol 的兼容；这些 Draft 数据没有生产消费者；
- 延期 projection quarantine GC 到 projection owner 自己的 lifecycle 交付；
- 延期 dependency environment 与 Write/Edit 恢复的耦合；纯文件 transform 不应被 npm producer 阻塞；
- 禁止为使旧 PR 可编译而恢复 v1/v2 fallback。

## 7. 当前重建状态

- R0：完成。Runtime 不再接受 Host 提交的 `providerResult`；运行时夹带字段也会被忽略。
- R1：完成。candidate receipt/ref 支持 exact replay 与 source import retry。
- R2：owner 主链已完成：durable epoch/head、pure transform、candidate、SQLite successor 与 accepted-ref
  projection 已串联；真实子进程会在 SQLite successor 提交后直接退出，新 owner 只从 durable evidence
  重建 candidate 并推进 accepted ref。该用例已进入三平台 Gitoxide helper workflow。
- R3：accepted-ref projection 已实现为 accepted truth 的派生 CAS；filesystem checkout projection 仍保持
  独立延期，不参与 canonical Write/Edit read/write。
- R4：session owner 已完成 source admission/import、durable baseline、helper identity/source drift 校验和
  import 后进程退出的 exact retry；packaged resource 与 Host 产品入口仍待接线。npm producer 不再作为纯
  Write/Edit 恢复链的前置。
- R5：尚未在新基线上重建。
