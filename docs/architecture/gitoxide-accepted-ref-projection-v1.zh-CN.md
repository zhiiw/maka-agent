# Gitoxide accepted-ref projection v1

## 主要不变量

一次 managed Write/Edit 的 Git candidate 只有在 SQLite 已原子接受对应 tool outcome、workspace
successor 与 canonical head 后，才可以把 `refs/maka/accepted` 从精确 base commit 推进到 candidate
commit。响应丢失或进程重启只能重放同一 CAS，不能重新执行 Write/Edit。

## Owner 与权限

- SQLite workspace successor authority 是 accepted truth owner；成功事务返回 owner-bound、不可伪造的
  `WorkspaceSuccessorProjectionCapabilityInternal`。
- Gitoxide candidate receipt authority 是 projection coordinator；它同时验证 durable receipt、in-process
  candidate capability 与上述 SQLite capability。
- short-lived Gitoxide helper 是 ref CAS data-plane owner。普通 Host caller、裸 receipt 或裸 OID 都不能
  直接要求 projection。

## 原子性边界

Git 与 SQLite 不能组成一个物理事务，因此协议刻意采用有序的两个线性化点：

1. SQLite transaction 先接受 T2、successor fact、head CAS，并释放 mutation reservation；
2. helper 使用 `MustExistAndMatch(base)` 将 accepted ref 推进到 candidate。

若第二步前后崩溃，accepted truth 已经存在。恢复只重验 candidate commit/tree/blob/request digest 并重放
ref CAS；accepted ref 已等于 candidate 时返回 exact replay success，任何第三值均 fail closed。

## 失败状态与回滚

| 状态 | 处理 |
| --- | --- |
| SQLite 未接受 successor | 不签发 projection capability，candidate ref 仍是未接受 artifact |
| accepted ref 仍为 exact base | 允许一次 CAS 到 exact candidate |
| accepted ref 已为 exact candidate | 返回 replay success，不再次移动 ref |
| candidate ref/commit/tree/blob/request digest 漂移 | fail closed，不修改 accepted ref |
| accepted ref 为第三值 | projection conflict；禁止覆盖、reset 或 fallback |
| CAS 返回错误但 ref 已到 candidate | 重新观察后收敛为 replay success |
| CAS 返回错误且 ref 仍为 base | outcome indeterminate；保留 accepted truth，稍后重试，不重跑工具 |

## 平台能力矩阵

Linux、macOS、Windows 使用相同 Gitoxide ref transaction 与 strict protocol。v1 承诺进程崩溃后的
exact retry；不把普通文件系统/设备的断电持久性描述成三平台统一保证。

