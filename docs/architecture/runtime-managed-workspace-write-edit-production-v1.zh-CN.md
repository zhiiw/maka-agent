# Managed Workspace Write/Edit Production Composition v1

- 阶段：M2.4
- 状态：API-only Draft；Runtime Host 已消费显式 `managed-coding-v1` profile，但 Desktop/CLI 尚未创建该类 session
- owner：Runtime Host composition + `ManagedWorkspaceOwner` + SQLite workspace authority
- 不包含：workspace-bound continuation（M3）、自动 restore/rebaseline/publish（M4）

## 1. 主要不变量

真实 Write/Edit 只有在下面这条 owner 链完整成立时才可进入 managed durable mode：

```text
explicit managed-coding-v1 profile
  -> Host 打开同一个 owner-bound managed workspace execution handle
  -> owner 从真实 filesystem worker permission profile + protocol 计算 profile digest
  -> Git owner 从 accepted base tree 读取目标路径的 exact base blob/content
  -> T1 原子持久化 call + dispatch + exact base tree/blob/path/profile + exclusive reservation
  -> worker 只读 immutable base content，在不写 worktree 的情况下运行生产 transform
  -> Runtime 得到 exact result content/blob；Git owner 重新 hash 并写入 private index/candidate
  -> SQLite 原子提交 exact T2 + successor fact + canonical head，并释放 reservation
  -> Git candidate 幂等 accept，通过目录轮换把 worktree 投影到 SQLite accepted head
```

caller 不能提供 cwd、base head、candidate、execution profile digest 或 terminal result。普通
`headless-coding-v1` 不会因为 bundled Git/worker 恰好可用而静默升级；只有显式 profile 在 T1 前选择
`managed_mutation_v1`。execution boundary 读取、owner admission、canonical path 和其他可失败 preflight
必须在 T1 前完成；缺失 owner、worker、Git、SQLite authority 或任一 identity mismatch 都在 T1 前拒绝。
Owner 只签发与 `expectedPaths[0]` 相同的 `canonicalPath`，没有改写 `content`、`old_string` 或
`new_string` 的权限；真实执行参数由 Runtime 从已经校验并写入 durable call 的原始参数重建。

首版 profile 的工具面严格限定为 `Read/Glob/Grep/Write/Edit`。`Bash` 与 `apply_patch` 尚无等价的 effect
owner 和 successor 协议，因此不会暴露给 managed task；不能借由这些工具绕过 canonical workspace head。

## 2. 唯一事实源和原子边界

| 事实/投影 | owner | 原子边界 |
|---|---|---|
| provider result | Tool Runtime | 一次 bounded strict-JSON snapshot；Host 只能看到 proof，不能重交 result |
| mutation reservation | SQLite workspace authority | 与 T1 call/dispatch 同一 transaction |
| accepted workspace head | immutable RuntimeEvents | exact T2 + successor fact + projection/head CAS + reservation release 同一 transaction |
| Git candidate | Git candidate owner | private index、candidate ref CAS、durable receipt |
| worktree 当前内容 | Git projection | 从 SQLite accepted head + durable candidate receipt 幂等物化；不是 transform 输入，也不是 accepted truth |

SQLite successor 已提交而 Git accept 尚未完成时，系统已经拥有 canonical accepted truth。新进程重新打开
workspace 时必须从 SQLite head 找到 operation-bound candidate，严格重验 commit/tree/path/profile 后再 accept；不得
重新执行 Write/Edit。

changed-path 集合不是内容因果证据。首版 Write/Edit 只允许一个 canonical path，T1 中的 `baseBlobOid`
绑定 accepted Git tree 的 preimage（新建文件为 `null`）。Git owner 同时从该 tree 读取 bounded UTF-8
`baseContent`，但 content 不作为第二份 durable fact；worker 的 operation boundary 只描述目标 identity，实际 sandbox
profile 不授予任何 workspace read/write 权限；worker 只从受限 request 读取 base content 并运行生产 transform，
既不读取也不写入 worktree，并返回 bounded `resultContent/resultBlobOid`。Git owner 对 result content 重新执行
Git object hash，把 exact blob 写进 private index，再构造 candidate。candidate receipt 最终把该 blob 绑定到
immutable Git tree。

因此 managed worktree 是可丢弃投影，不是 mutation data plane。外部进程在 admission 后修改同一路径时：

- candidate capture 前发现 projection drift：fail closed，不吸收外部内容；
- candidate capture 后、projection publish 前发生 drift：旧目录整体移入 quarantine，外部内容原样保留；
- 新 projection 发布后再发生 drift：最终验证拒绝，不运行 `reset --hard` 覆盖内容。

rotation intent 在移动前持久化旧 worktree 根目录的 device/inode identity。恢复只接受同一非 symlink
目录出现在确定性 quarantine path；预置 symlink、Windows junction 或其他 identity replacement 一律 fail closed。
projection owner 不通过 quarantine 子路径删除 `.git` 或其他文件，旧目录作为完整树保留，避免路径在校验后再次
被替换时产生越界删除。

本协议明确禁止“校验 worktree preimage 后再原地覆盖”的 read-check-write，因为跨进程写入无法由进程内锁
线性化。当前 bounded Git/worker transport 只支持 UTF-8 text；二进制或超过 transport 上限的目标在 T1 前
fail closed。

## 3. 无副作用终态

T1 后只允许进入四种互斥状态：

- `workspace_successor_committed`：成功、有 workspace 变化，T2/successor/head/reservation 已原子收敛；
- `no_workspace_change_committed`：成功、无 workspace 变化，success T2/terminal/reservation 已原子收敛；
- `operation_failed_no_effect_committed`：失败、且 Git owner 已证明无副作用，error T2/terminal/reservation 已原子收敛；
- `unsettled`：副作用或 durable proof 不能证明，保留 reservation 并 fail-stop。

失败 Write/Edit 与成功 no-op 不允许回退 generic T2。真实 `FilesystemWorkerClient` 的确定性业务 reject 先由
Runtime 捕获为唯一、不可变、bounded strict-JSON error proof；Owner 再证明 worktree 仍精确等于 T1 base。随后专用
SQLite writer 在一个 transaction 内提交：

```text
exact Runtime-owned function_response
+ managed_mutation_terminal_v1 fact
+ exact reservation release
+ unchanged canonical workspace head
```

terminal fact 的 disposition 只有：

- `operation_failed_no_effect_committed`：response 必须为 error；
- `no_workspace_change_committed`：response 必须为 success。

terminal fact、T1 mutation identity、dispatch/outcome identity、base head 与 expected paths 在 online writer 和 rebuild
中都要一致。generic append/import 和 generic T2 writer 无权写入该 fact。若 worker 可能已改变文件、Git 状态漂移、
terminal fact 缺失/损坏或 candidate 无法重验，则保留 reservation 并 fail-stop/park。

T1 后取消不允许在 operation capability 之前短路。Runtime 仍调用唯一一次 operation capability；若 worker 因已经
取消而在产生副作用前拒绝，Runtime 将该拒绝冻结为 error proof，Owner 在 clean-base 证明后提交
`operation_failed_no_effect_committed`。如果 clean-base 无法证明，则保持 `unsettled`。

## 4. 失败状态与回滚

| 崩溃/失败点 | durable 状态 | 重启行为 |
|---|---|---|
| T1 前 | 无 reservation | 明确失败，可重新 admission |
| T1 后取消，worker 明确未产生 effect 且 Git clean | error T2 + terminal fact | 已收敛，head 不变 |
| T1 后、worker 前/中，effect 不可证明 | reservation 保留 | park；M2.4 不自动猜测或覆盖 |
| candidate capture 前 projection 出现任何外部 drift | reservation 保留 | park/quarantine；不得吸收到 successor |
| worker error 且 Git owner 证明 clean base | error T2 + terminal fact | 已收敛，head 不变 |
| success 但 tree 无变化 | success T2 + terminal fact | 已收敛，head 不变 |
| candidate capture 后、SQLite commit 前 | T1 + candidate artifact | reservation 保留；不得对外宣称成功 |
| SQLite successor commit 后、projection rotation intent 前 | accepted successor + candidate receipt | reopen 幂等 accept，不重跑工具 |
| rotation 已保存旧目录、尚未发布新投影 | durable rotation intent + identity-bound quarantined previous projection | reopen 重验目录 identity 后发布新投影；旧完整树仍可取回 |
| rotation 已发布新投影、尚未推进 Git metadata/ref | durable rotation intent + 两份目录 | reopen 只推进 metadata/ref 并验证；不原地覆盖文件 |
| Git accept 后、provider publication 前 | accepted successor | Runtime 采用 exact durable outcome；后续 replay 同值 |
| 外部修改或 evidence mismatch | 不推进/不覆盖 | quarantine 或 park |

## 5. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| T1/reservation/terminal/successor SQLite 原子性 | 承诺 | 承诺 | 承诺 |
| exact Write/Edit path + worker profile binding | 承诺 | 承诺 | 实现并由边界测试证明；当前 recovery runner 未打包 broker |
| candidate capture/accept process-crash 收敛 | CI 证明 | CI 证明 | CI 证明 |
| 外部并发写不被 projection rotation 覆盖 | rename 后旧 inode/目录进入 quarantine；symlink tamper CI 拒绝 | rename 后旧 inode/目录进入 quarantine；symlink tamper CI 拒绝 | 可 rename 时保留旧目录；junction tamper 拒绝；打开句柄阻止 rename 时 fail closed |
| 真实 Host/worker 在 successor commit 后 kill、reopen 不重跑 | CI 证明 | CI 证明 | release broker 存在；当前 recovery runner 明确 skip |
| power-loss 后硬件永久写入顺序 | 不承诺 | 不承诺 | 不承诺 |

统一 recovery inventory 执行真实 child process kill/reopen，并覆盖旧 projection 已移动及新 projection 已发布两个
rotation crash 点。Linux/macOS 的组合测试经过 Runtime Host、ToolRuntime、
真实 `FilesystemWorkerClient`、Git owner 与 SQLite authority，并在 reopen 后执行一个真实 `edit_conflict`，证明 worker
reject 能收敛为 no-effect error terminal；Windows runner 仍执行 30 条 SQLite/Git crash 用例，但
因没有构建发布包内的 Rust sandbox broker，完整 Host/worker 用例以一个显式 skip 记录，不能表述为已由该 lane 证明。
这里的承诺是 process-crash convergence，不把普通 `fsync`、Git ref 或 SQLite WAL 夸大为断电级证明。

Projection quarantine 是有意的恢复边界：M2.4 在成功 rotation 后保留旧目录，从而不会为了“自动恢复”删除
并发写入或仍被外部 fd 引用的 inode。它会增加磁盘占用；配额、宽限期、诊断与安全 GC 由 M4 的 restore/rebaseline
生命周期 owner 统一实现。在该 owner 落地前，本 API 维持 Draft，不能把无界保留包装成生产级缓存策略。

## 6. 用户可见边界

M2.4 完成的是“显式 managed coding task 中，一次 Write/Edit 的执行与 accepted workspace version 原子闭环”。
当前入口是 Runtime Host API/profile，Desktop/CLI 还不会创建 `managed-coding-v1` session，因此本切片继续保持 Draft。
它也还不是“任意中断点自动继续整段对话”：把 continuation cursor 与 accepted workspace version 绑定、在重启后继续
provider loop 属于 M3。attached checkout 仍保持原能力，不会自动获得 managed redo/restore。
