# Durable Shell Recovery Settlement v1

## 1. 范围

本切片消费 `durable-shell-effect-correlation-v1` 的 ShellRun claim，把 Host 重启后仍缺少 T2 的 managed Bash
操作收敛为确切结果或保守 park。它不重启命令、不把 orphaned 记录猜成失败结果，也不宣称远端服务 exactly-once。

## 2. 主要不变量

> Host recovery 只有在 immutable RuntimeEvent T1、ShellRun source identity 与 terminal record 三者完全一致时，
> 才能提交 Bash T2。starting、running、orphaned 或身份不一致都不能产生 provider outcome；恢复路径绝不 spawn。

managed Bash 在 T1 前选择 `recoveryMode=reattach`。该模式没有 legacy fallback：

```text
T1 reattach operation
  + exact source-operation claim absent
      -> claim-before-spawn 证明 command 未启动 -> 提交 error T2
  + exact terminal claim
      -> 根据原 function_call 的 foreground/background 参数重建 exact result -> 提交 T2
  + starting/running/orphaned claim
      -> 保留 T1 -> continuation park
  + identity / ledger mismatch
      -> fail closed
```

## 3. Owner 与原子边界

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| RuntimeEvent authority | immutable call/dispatch、canonical args hash、T2 | Shell process state |
| ShellRun authority | claim-before-spawn、process output、terminal record | Runtime T2、自动继续策略 |
| Runtime Host recovery owner | 交叉验证两套 identity、构造一次 recovery T2 | 重跑 Bash、修改既有 ShellRun 证据 |
| Continuation owner | T2 后是否继续；无 T2 时 park | 猜测 shell outcome |

RuntimeEvent T2 仍由现有 `commitToolOutcome()` 事务提交。ShellRun record 是外部效果证据，不是第二份 Runtime
ledger。并发 recovery 的 exact retry 由同一个 operation response identity 与 commit writer 幂等收敛。

## 4. 失败状态和回滚

- claim 不存在：因为 spawn 严格发生在 durable claim 之后，可以证明没有进程效果；提交 `command_not_started` error；
- terminal claim：foreground 恢复为 terminal result；background 恢复为 ShellRun snapshot；
- starting/running：可能已经 spawn，保留未结算 T1；Session recovery 随后把无 live owner 的记录标为 orphaned；
- orphaned：继续 park，不能把“进程句柄丢失”误写成命令失败；
- request hash、Run、Turn、toolCall 或 Runtime ledger 不一致：恢复整体 fail closed；
- T2 commit 后响应丢失：下一次 recovery 不再列出该 operation，幂等返回。

没有通用 rollback。Shell 副作用不能通过删除 ShellRun 或 RuntimeEvent 撤销。

## 5. 平台能力矩阵

| 平台 | 承诺与证据 |
| --- | --- |
| Linux | 标准 Runtime Host suite 运行真实 child-process exit/reopen 测试 |
| Windows | `windows-recovery` 严格运行同一 terminal adoption crash test，0 skip |
| macOS | 使用相同 SQLite/Node 协议，当前实现预期一致；尚未配置该切片的独立 macOS 发布 gate |

真实 crash test 启动 Node child、提交 T1、运行一次真实命令并持久化 terminal ShellRun，然后在 T2 前以非零码
退出。新进程恢复后 marker 仍只有一个字节，Runtime ledger 只新增一个 matching response，再次恢复不产生写入。

## 6. 后续

下一切片在这个结算基础上约束受控 foreground Bash/npm/test coding loop，并对完整 Runtime Host kill/restart、
sandbox profile、dependency snapshot 与 continuation capsule 做组合验证。任意外部网络效果仍需要独立 acceptance
evidence、幂等键或 park，不能从本地 ShellRun 推导远端 exactly-once。
