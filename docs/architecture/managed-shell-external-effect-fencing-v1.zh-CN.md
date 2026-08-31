# Managed Shell 外部副作用围栏 v1

## 范围

本合同定义一个受限的、前台 `ShellRun` 专用外部副作用边界。它不是任意远端 API 的 exactly-once 框架。产品消费者是 `managed-coding-v2` 中的 fenced Bash；只有能够证明 command sandbox 的 Host 才广告该 profile。

输入世界固定为一个已接受的 Git tree：

```text
accepted workspace head
        ↓ authority-owned disposable materialization
foreground ShellRun
        ↓ durable ShellRun claim / terminal record
provider outcome or recovery adoption
```

## Owner

- Runtime 拥有 operation capability、provider result 和 T1/T2 顺序。
- Shell external-effect admission owner 拥有 accepted-head 读取、一次性 materialization 和 execution-root 生命周期。
- ShellRun store 拥有本地进程 claim 与 terminal record。
- SQLite RuntimeEvents 是工具调用、围栏和 provider outcome 的唯一 accepted truth。

调用者只能提交 `command` 与可选 `timeout_ms`。v1 明确拒绝后台任务、PTY 和额外参数；因此 execution root 不会在仍有一个受支持的后台 ShellRun 使用它时被回收。

一次性目录统一位于 unpublished canonical `managed-disposable-executions-v2` namespace。新 Host 的第一次 allocation 会在独占 storage-root owner 下删除上一进程遗留的 execution roots；不存在 v1 目录迁移或兼容读取。

## T1 原子边界

T1 前必须完成：

1. 校验 exact Bash 参数；
2. 读取 accepted workspace identity；
3. 分配 authority-owned execution root；
4. 将 exact accepted commit/tree 物化到 disposable root；
5. 验证 materializer 返回的 commit/tree 与 accepted boundary 一致；
6. 签发只可调用一次的 operation capability。

T1 同时持久化 `external_effect_v1`，其中包含 operation id、本地 idempotency key、ShellRun authority、reconciliation contract、workspace epoch、accepted head 以及 execution-profile digest。T1 后禁止退回普通 Bash 路径。

`idempotencyKey === operationId` 只保证 Maka 本地 ShellRun claim 的唯一性。除非目标服务另行提供 acceptance evidence 或接受相同幂等键，否则它不证明网络端 exactly-once。

## 失败与恢复

| 可观察状态 | 处理 |
| --- | --- |
| T1 前 admission/materialization 失败 | 不执行命令，不写 T1，删除 execution root |
| T1 已存在，但没有 ShellRun claim | 证明命令未启动，提交 `command_not_started` error outcome |
| ShellRun 为 starting/running/orphaned | park；不重启、不猜测退出状态 |
| ShellRun 已 terminal | 校验 source operation identity 后采用 durable terminal result |

Runtime 必须等待已经进入 `running` 的 operation capability 结束，owner 不得通过提前返回让副作用越过 terminal publication。cleanup 是幂等的，且不得覆盖已经持久化的 T1/T2 结论。

production-shaped crash gate 必须覆盖更窄的关键窗口：真实 ShellRun terminal record 已经持久化，但
Runtime 尚未提交 provider T2。测试 Host 在 terminal durability observer 中停住，父进程确认握手后强杀整个 Host；
新 Host 必须从 ShellRun authority 采用一次原结果、写出唯一 T2，并且命令执行次数保持为 1。

## 平台能力矩阵

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| accepted tree 一次性物化 | 实现预期 | 实现预期 | 实现预期 |
| 前台 ShellRun 本地 claim/terminal adoption | 已有 ShellRun authority | 已有 ShellRun authority | 已有 ShellRun authority |
| foreground fenced Bash | bubblewrap 可用时开放 | Seatbelt 可用时开放 | 不开放；任意 shell AppContainer 尚不可证明 |
| 后台/PTY managed effect | 拒绝 | 拒绝 | 拒绝 |
| 远端 exactly-once | 不承诺 | 不承诺 | 不承诺 |

Linux/macOS 的 packaged Host 只有在 Gitoxide、managed Node toolchain 和 foreground command sandbox 同时可用时才广告 `managed-coding-v2`。Windows 继续返回 profile unavailable。缺少任何 authority 都必须在 T1 前 fail closed，禁止退回 attached-checkout Bash。
