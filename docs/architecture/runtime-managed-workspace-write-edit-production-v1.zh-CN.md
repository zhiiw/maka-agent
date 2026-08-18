# Managed Workspace Write/Edit Production Composition v1

- 阶段：M2.4
- 状态：实现切片；首个生产消费者为显式 `managed-coding-v1` profile
- owner：Runtime Host composition + `ManagedWorkspaceOwner` + SQLite workspace authority
- 不包含：workspace-bound continuation（M3）、自动 restore/rebaseline/publish（M4）

## 1. 主要不变量

真实 Write/Edit 只有在下面这条 owner 链完整成立时才可进入 managed durable mode：

```text
explicit managed-coding-v1 profile
  -> Host 打开同一个 owner-bound managed workspace execution handle
  -> owner 从真实 filesystem worker permission profile + protocol 计算 profile digest
  -> T1 原子持久化 call + dispatch + exact base/path/profile + exclusive reservation
  -> worker 只在该 admission 的 mutation scope 内执行
  -> Git owner capture exact candidate
  -> SQLite 原子提交 exact T2 + successor fact + canonical head，并释放 reservation
  -> Git candidate 幂等 accept，将 worktree 投影到 SQLite accepted head
```

caller 不能提供 cwd、base head、candidate、execution profile digest 或 terminal result。普通
`headless-coding-v1` 不会因为 bundled Git/worker 恰好可用而静默升级；只有显式 profile 在 T1 前选择
`managed_mutation_v1`。缺失 owner、worker、Git、SQLite authority 或任一 identity mismatch 都在 T1 前拒绝。

首版 profile 的工具面严格限定为 `Read/Glob/Grep/Write/Edit`。`Bash` 与 `apply_patch` 尚无等价的 effect
owner 和 successor 协议，因此不会暴露给 managed task；不能借由这些工具绕过 canonical workspace head。

## 2. 唯一事实源和原子边界

| 事实/投影 | owner | 原子边界 |
|---|---|---|
| provider result | Tool Runtime | 一次 bounded strict-JSON snapshot；Host 只能看到 proof，不能重交 result |
| mutation reservation | SQLite workspace authority | 与 T1 call/dispatch 同一 transaction |
| accepted workspace head | immutable RuntimeEvents | exact T2 + successor fact + projection/head CAS + reservation release 同一 transaction |
| Git candidate | Git candidate owner | private index、candidate ref CAS、durable receipt |
| worktree 当前内容 | Git projection | 从 SQLite accepted head + durable candidate receipt 幂等重放；不是 accepted truth |

SQLite successor 已提交而 Git accept 尚未完成时，系统已经拥有 canonical accepted truth。新进程重新打开
workspace 时必须从 SQLite head 找到 operation-bound candidate，严格重验 commit/tree/path/profile 后再 accept；不得
重新执行 Write/Edit。

## 3. 无副作用终态

失败 Write/Edit 与成功 no-op 不允许回退 generic T2。Owner 先证明 worktree 仍精确等于 T1 base，然后由专用
SQLite writer 在一个 transaction 内提交：

```text
exact Runtime-owned function_response
+ managed_mutation_terminal_v1 fact
+ exact reservation release
+ unchanged canonical workspace head
```

terminal fact 的 reason 只有：

- `operation_failed_no_effect`：response 必须为 error；
- `no_workspace_change`：response 必须为 success。

terminal fact、T1 mutation identity、dispatch/outcome identity、base head 与 expected paths 在 online writer 和 rebuild
中都要一致。generic append/import 和 generic T2 writer 无权写入该 fact。若 worker 可能已改变文件、Git 状态漂移、
terminal fact 缺失/损坏或 candidate 无法重验，则保留 reservation 并 fail-stop/park。

## 4. 失败状态与回滚

| 崩溃/失败点 | durable 状态 | 重启行为 |
|---|---|---|
| T1 前 | 无 reservation | 明确失败，可重新 admission |
| T1 后、worker 前/中，effect 不可证明 | reservation 保留 | park；M2.4 不自动猜测或覆盖 |
| worker error 且 Git owner 证明 clean base | error T2 + terminal fact | 已收敛，head 不变 |
| success 但 tree 无变化 | success T2 + terminal fact | 已收敛，head 不变 |
| candidate capture 后、SQLite commit 前 | T1 + candidate artifact | reservation 保留；不得对外宣称成功 |
| SQLite successor commit 后、Git accept 前 | accepted successor + candidate receipt | reopen 幂等 accept，不重跑工具 |
| Git accept 后、provider publication 前 | accepted successor | Runtime 采用 exact durable outcome；后续 replay 同值 |
| 外部修改或 evidence mismatch | 不推进/不覆盖 | quarantine 或 park |

## 5. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| T1/reservation/terminal/successor SQLite 原子性 | 承诺 | 承诺 | 承诺 |
| exact Write/Edit path + worker profile binding | 承诺 | 承诺 | 承诺 |
| candidate capture/accept process-crash 收敛 | CI 证明 | CI 证明 | CI 证明 |
| successor commit 后进程 kill、reopen 不重跑 | CI 证明 | CI 证明 | CI 证明 |
| power-loss 后硬件永久写入顺序 | 不承诺 | 不承诺 | 不承诺 |

统一 recovery inventory 执行真实 child process kill/reopen。这里的承诺是 process-crash convergence，不把普通
`fsync`、Git ref 或 SQLite WAL 夸大为断电级证明。

## 6. 用户可见边界

M2.4 完成的是“显式 managed coding task 中，一次 Write/Edit 的执行与 accepted workspace version 原子闭环”。
它还不是“任意中断点自动继续整段对话”：把 continuation cursor 与 accepted workspace version 绑定、在重启后继续
provider loop 属于 M3。attached checkout 仍保持原能力，不会自动获得 managed redo/restore。
