# Durable Shell Effect Correlation v1

## 1. 范围

本切片只建立 Runtime tool operation 与 ShellRun process effect 的唯一 durable correlation。它不自动恢复任意
Bash，不宣称外部服务 exactly-once，也不把活跃/孤儿进程猜成成功。后续 recovery owner 只能消费这里形成的
ShellRun 证据。

## 2. 主要不变量

> 同一个 Runtime `operationId` 在一个 Session 中最多创建一个 ShellRun；ShellRun claim 必须先于 process spawn
> 持久化。精确重试只能采用相同 request hash 的既有 terminal record，绝不能启动第二个进程；identity 不同或
> record 仍 active 但没有 live owner 时必须 fail closed。

## 3. Owner 与原子性边界

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| ToolRuntime | `operationId`、T1/T2 与 canonical tool args | Shell process、ShellRun result |
| Managed Bash adapter | 把 Runtime `operationId` 传给 ShellRun owner | 自行生成/替换 operation identity |
| SQLite ShellRun store | `(sessionId, sourceOperationId)` 唯一 claim、request hash、record | process spawn、Runtime T2 |
| ShellRun manager | claim 后的 process tree、output、terminal transition、exact retry adoption | 修改 claim identity、自动解释外部远端结果 |

SQLite partial unique index 是跨进程仲裁边界。`claimShellRun()` 在同一个 write transaction 内读取既有 claim 或
插入新 claim。ShellRun manager 只有在 `created=true` 后才可 spawn：

```text
Runtime T1
  -> exact ShellRun request hash
  -> SQLite ShellRun claim
  -> process spawn
  -> terminal ShellRun record
  -> Runtime T2
```

request hash 直接采用 Runtime 在 T1 中提交的 canonical tool-args hash，由 `MakaToolContext` 与同一个
`operationId` 一起签发给内置 Bash adapter。ShellRun owner 不从可变的环境、临时 sandbox path 或 fd number
重新推导 identity；这些执行细节由 T1 前选定的 execution/sandbox authority 约束。

## 4. 失败与恢复

- T1 后、claim 前崩溃：没有 process effect 证据；后续 recovery owner 可按协议决定是否重新 admission；
- claim 后、spawn 前崩溃：record 为 active 且无 live owner，保守 park；不得假定 command 未执行；
- spawn 后、terminal 前崩溃：同样 park/outcome unknown，禁止自动重跑；
- terminal record 已提交、Runtime T2 丢失：精确重试采用 terminal record，不 spawn；后续切片负责提交 T2；
- 相同 operation、不同 request hash：durable corruption/identity conflict，fail closed；
- 多进程同时 claim：唯一索引只允许一个 `created=true`，其他 caller 取得同一个既有 record。

该切片没有通用 rollback。Shell command 可能已经产生外部效果，删除 claim 不能撤销效果，因此禁止用删除记录伪装
回滚。

## 5. 平台矩阵

| 平台 | 当前承诺 |
| --- | --- |
| Linux | SQLite claim 在 spawn 前；exact terminal retry 不重跑 |
| macOS | 与 Linux 相同 |
| Windows | 与 Linux 相同；真实多进程 claim 测试使用同一 operational SQLite authority |

process-crash 证据包括真实双进程同时 claim；命令 exact retry 测试使用真实 Node child process 并验证 marker 只写入
一次。CI 绿不能把 active/orphaned record 提升为成功证据。

## 6. 后续切片

下一层 recovery settlement 必须只产生三种结论：

1. terminal ShellRun + exact identity：采用并提交 T2；
2. 没有 claim 且有“spawn 必在 claim 后”的证明：允许重新 admission；
3. active/orphaned/identity 不完整：park，等待用户或更强的外部 acceptance evidence。
