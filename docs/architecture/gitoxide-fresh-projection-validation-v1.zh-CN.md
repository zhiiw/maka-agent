# Gitoxide fresh projection validation v1

状态：验证切片，堆叠在 repository admission 与 successor CAS 验证之后；没有生产消费者，保持
Draft。

## 1. 主要不变量

本切片只验证：

> Gitoxide broker 能从 Maka-owned SHA-1 repository 的精确 accepted commit，把受支持的 tree
> 物化到一个此前不存在的 staging directory；它不创建 `.git`、index 或 linked-worktree
> registration。只有 broker 返回完整成功响应后，上层 owner 才能把 staging 作为 projection
> 候选。进程中断或任意失败留下的目录一律是不可信 staging，可整体删除并从 accepted commit
> 重建。

它不执行 canonical-path rename，不写 SQLite/receipt，也不宣称 power-loss durability。

## 2. Owner 与边界

| 项目 | v1 约束 |
| --- | --- |
| owner | 单次 `maka-gitoxide-broker` `materialize_projection` 请求 |
| source | SHA-1 repository + exact commit OID |
| destination | parent 必须存在，destination 必须不存在；broker 仅用 `create_dir` 取得 fresh root |
| 支持 entry | tree、`100644` blob、`100755` executable blob |
| 拒绝 entry | symlink、submodule、special mode、`.gitattributes`、`.git`、非 UTF-8/非 canonical component |
| collision | 对完整 relative path 做 NFC + Unicode lowercase collision 检测 |
| 资源上限 | 单文件 64 MiB、总计 2 GiB、最多 200,000 文件；在加载 blob 前先读取 object header |
| Git control capability | projection 中不生成 `.git`、HEAD、index、ref 或 worktree registration |

## 3. 原子性、失败和回滚

文件物化本身不是原子事务。这个切片刻意把原子边界放在后续 owner 的目录 publication：

```text
accepted commit（immutable）
  -> create fresh staging root
  -> materialize all entries
  -> broker success response
  -> [后续切片] verify staging
  -> [后续 owner] rename staging to canonical projection
```

- destination 已存在：在读取/写入任何 projection file 前拒绝，不覆盖其中的外部内容。
- entry、路径、配额或 I/O 失败：返回稳定 error；partial staging 保留为不可信 artifact。
- broker 被 kill：不产生 durable success fact；上层必须删除整个 staging，不能“检查起来完整就接着用”。
- retry：使用新的 fresh destination，从同一 immutable commit 重新物化。
- accepted Git ref/object 不被本操作修改，因此无需 Git rollback。

真实 child-process 测试在一个 64 MiB blob 开始写入后终止 broker，删除 staging，再由新进程从同一
commit 完整重建；这证明 process-crash discard/retry，不证明断电持久性。

## 4. 安全范围

该验证面向 Maka-owned 私有 staging root，防止意外路径碰撞、预存内容覆盖以及 Git tree 中的
symlink/control metadata 获得文件系统能力。它**不**声称抵御同一 OS 用户下的恶意进程在物化期间
持续替换刚创建的目录。生产接入必须把 staging 放进 owner-only root，并在 publication 前通过下一
切片的 projection observation 复验；若威胁模型要求抵御恶意同用户进程，则还需平台级 directory
capability/openat/no-follow owner，不能靠更多 stat 检查冒充原子隔离。

## 5. 平台能力矩阵

| 平台 | 当前验证 | 限制 |
| --- | --- | --- |
| Linux | fresh tree、nested file、`100755`、kill/discard/retry | 无 power-loss/恶意同用户隔离承诺 |
| macOS | 同 Linux | 无 `F_FULLFSYNC`/签名发布承诺 |
| Windows | fresh tree、nested file、no `.git`、kill/discard/retry | executable bit 无工作树语义；完整 Host crash 尚未接入 |

三平台使用同一个 locked Cargo test suite。测试中的 Git CLI 仅创建和独立验证 fixture；broker
子进程 `PATH` 为空，无法回退到 system Git。

Windows x64 未专门 strip 的 release broker 为 8,138,752 bytes（约 7.76 MiB），相对 successor
CAS probe 增加 48,128 bytes（约 0.05 MiB）。`unicode-normalization` 已存在于原 locked gix
closure，本切片只是直接使用，因此 package 总数仍为 138，未引入新的 GPL/AGPL-only dependency。

## 6. 下一步

下一切片只验证 projection observation：从 accepted tree 独立重算目录的 tracked content、mode、
type 和额外路径，任何 drift 都 fail closed。只有 materialize + observe 都成立后，才值得设计
canonical directory publication；不能重新引入 linked-worktree registration。
