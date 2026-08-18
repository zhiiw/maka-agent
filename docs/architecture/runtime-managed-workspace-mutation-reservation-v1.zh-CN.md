# Managed Workspace Mutation Reservation v1

- 阶段：M2.3a
- 状态：实现切片；保持 Draft，等待 M2.3b admission 与 M2.4 Write/Edit 生产消费者
- owner：SQLite workspace mutation authority

## 1. 主要不变量

同一个 `workspaceInstanceId` 从 managed mutation 的 T1 durable 起，到该 operation 被可信 successor
原子接受之前，只能存在一个 durable mutation owner。进程内 lease 只负责 capability 隔离，不再承担跨进程、
跨重启的排他真相。

T1 同时冻结 repository/workspace/epoch/instance identity、canonical base head、平台无关的 exact expected
paths、execution profile digest，以及 operation/dispatch identity。

任何 managed T1 都不得由通用 T2 writer 结算。成功只能通过 workspace successor authority 在同一个
SQLite transaction 中提交 `T2 + version_accepted + projection + head CAS`，并消费 reservation。

## 2. 权威与投影

唯一事实源仍是 immutable RuntimeEvents：

```text
function_call
  + toolDispatch.managedMutation
  + optional workspace version_accepted
```

`runtime_managed_mutation_reservations` 只是可重建投影。表以 `workspace_instance_id` 为主键，并对
`operation_id`、`dispatch_event_id` 建唯一约束。在线写入、canonical rebuild 和内部 reader 都先扫描
RuntimeEvents，再要求投影完全相等；删除或篡改投影不能改变事实。

## 3. 原子性边界

### 3.1 T1 reservation

一个 `BEGIN IMMEDIATE` transaction 内完成：

1. 重验 canonical workspace head；
2. 拒绝已有 active reservation；
3. 写 function call 与 dispatch RuntimeEvents；
4. 写 tool journal / operation projection；
5. 写 managed reservation projection；
6. COMMIT。

因此不存在“有 managed T1、没有 durable reservation”的正常可见状态。

### 3.2 successor acceptance

一个 transaction 内完成：

1. 读取 T1 与 reservation；
2. 比较 base、profile、operation、dispatch 与 exact changed paths；
3. 写成功 T2；
4. 写 immutable `workspace.version_accepted`；
5. 写 version projection；
6. CAS 推进 canonical head；
7. CAS 删除 reservation；
8. COMMIT。

失败、进程退出或 SQLite 异常使整组写入回滚。COMMIT 后响应丢失时，exact retry 返回原来的 immutable
successor，不重复推进 head。

## 4. 失败状态

| 状态 | 行为 |
|---|---|
| base/head 已变化 | T1 前拒绝，不创建 operation |
| 同 workspace 已有 reservation | T1 前拒绝，报告占用 operation |
| managed T1 走 generic T2 | 拒绝，operation 保持 prepared |
| successor paths 与 T1 不同 | 整个 successor transaction 回滚 |
| reservation 投影缺失或被篡改 | authority read/retry fail closed；允许从 RuntimeEvents rebuild |
| T1 后进程崩溃 | reservation 跨进程保留；新的 mutation 不能取得所有权 |
| operation park | reservation 保留，禁止另一个 mutation 越过未知副作用 |

`safely_discarded` 的 canonical release fact 不属于本切片；M2.4 在拥有真实 candidate 与 Write/Edit 结果后
定义。M2.3a 不提供手工删除 reservation 的公共 API。

## 5. 路径合同

Durable fact 使用平台无关的 Git path 语法：`/` 分隔、非绝对、无空段、无 `.`/`..`、无 NUL、反斜杠
或冒号；首段 `.git` 和 `node_modules` 一律按 ASCII case-insensitive 拒绝。路径集合必须排序、去重，
数量为 1–32。

这只是 canonical syntax。symlink、reparse point、volume case sensitivity 与真实路径 containment 仍由
M2.3b/M2.4 的平台 owner 在副作用前验证。Core 不读取 `process.platform`。

## 6. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| SQLite T1/accept transaction | 承诺 | 承诺 | 承诺 |
| 多进程同 workspace 唯一 reservation | 承诺 | 承诺 | 承诺 |
| process-crash 后 reservation 重建 | 承诺 | 承诺 | 承诺 |
| path fact 跨平台同值同义 | 承诺 | 承诺 | 承诺 |
| filesystem mutation/candidate correctness | M2.4 | M2.4 | M2.4 |

本切片不承诺断电后的 Git/filesystem 收敛，也不接 Desktop/CLI。

## 7. 验证

- strict Core decode：未知字段、非 canonical path、未排序 path set 均拒绝；
- T1 + reservation 原子持久化与 exact retry；
- generic T2 抢占被拒绝；
- changed paths 同时绑定 T1、successor fact、online writer 和 rebuild；
- projection 删除后 read/retry fail closed，rebuild 恢复；
- 真实子进程在 T1 COMMIT 后被杀，reopen 仍保留唯一 owner；
- 真实双进程同时提交不同 operation，恰好一个获得 reservation；
- successor transaction kill/reopen 继续沿用 M2.1 crash matrix。

## 8. 后续切片

### M2.3b — Runtime settlement seam

Runtime 接收未来 M2.4 Host owner 提供的 admission，但本切片只证明：managed T1 后不再进入 generic T2，且 live
result 只能采用与 T1 identity 完整一致的 durable response envelope。平台路径、execution profile、canonical
head 与 active-reservation admission 由 M2.4 的真实 mutation owner 统一证明。

### M2.4 — Write/Edit production settlement

真实 Write/Edit admission/profile、worker 执行、candidate capture/verification、owner-controlled settlement 与
reservation terminal transition 在此闭环。Runtime 必须能区分：successor 已接受、candidate 可安全 discard、
effect unknown/park；不能在 managed callback 后自动写 generic T2。
