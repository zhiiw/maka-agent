# Gitoxide mutation candidate retention GC v1

## 主要不变量

> GC 只能退役已经过期、且既不对应当前 accepted tool mutation、也不对应 active T1 reservation 的 mutation candidate。任何 durable root、receipt 或 Git ref 身份不明确时必须保留或 fail closed。

## Owner 与权限

- SQLite workspace authority 拥有 accepted head、当前 version origin 与 active mutation；
- managed Write/Edit owner 只输出 opaque retention roots，不暴露 successor writer；
- GC owner 有界枚举当前 workspace epoch 的 mutation candidate receipts；
- Gitoxide helper 只允许删除 `refs/maka/candidates/<operation-sha256>`，且必须同时证明 `refs/maka/accepted` 仍等于本轮冻结的 accepted commit、candidate ref 仍直接指向 receipt 中的 exact commit；
- GC 不获得 Git object、accepted/history/published ref、SQLite 或 source checkout 删除权限。

## 原子性与崩溃收敛

```text
read SQLite retention roots
  -> validate exact bounded receipt
  -> CAS delete exact candidate ref
  -> rename receipt to .gc-<uuid>
  -> delete tombstone
```

候选 ref 删除是 Git 线性化点。其后崩溃不会恢复 candidate：重试观察到 ref 缺失时返回 exact replay success，再完成 receipt tombstone。receipt rename 后崩溃时，新进程只删除 `.gc-*` regular-file tombstone。accepted ref 或 candidate ref 出现第三值时 fail closed。

## 保留范围

v1 明确保留：

- 当前 accepted tool mutation 的 candidate ref/receipt；
- active T1 reservation 的 candidate ref/receipt；
- 全部 accepted、baseline、history、published refs；
- 全部 history-candidate refs；
- 全部 loose/pack Git objects。

因此 v1 解决的是 mutation candidate ref/receipt 元数据增长，不宣称物理 object compaction。未来 object GC 必须先完整证明 continuation、publish、restore、audit 与 retention-policy roots，不能从本协议推断不可达。

## 平台矩阵

Linux、macOS、Windows 共享 exact-ref CAS 与 receipt tombstone 协议。进程退出后的收敛由真实 helper 与 child-process kill/reopen 测试证明；不承诺硬件断电、文件系统损坏或底层设备违反同步语义时自动恢复。
