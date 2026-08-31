# Managed Node workspace transform kernel v1

status: enabling infrastructure

milestone: M5 workspace transform

## 1. 主要不变量

一次 `ManagedNodeTransform` 必须是下面这条纯转换链：

```text
exact accepted Git tree + exact entry + exact argv
  -> sandboxed Node process
  -> one owner-selected bounded UTF-8 output
  -> immutable Gitoxide candidate
  -> atomic SQLite successor acceptance
  -> accepted ref projection
```

transform 不能直接写 managed worktree、accepted ref、用户 checkout 或任意调用者路径。模型只能选择 accepted
tree 中的显式 Node entry、一个 canonical output path 和有界 argv；物理 output path、cwd、environment、toolchain、
sandbox、timeout 与 candidate publication 都由 owner 决定。

本切片只建立 kernel。packaged manifest/profile v4、Desktop pre-Session negotiation 与真实 Host kill/reopen 属于
独立产品组合切片；在该切片落地前，生产 Host 不宣告此工具。

## 2. Owner 与权限

- accepted input owner：Gitoxide managed session；
- execution-root owner：短生命周期 accepted-tree materialization 与 scratch；
- toolchain/process owner：opaque toolchain capability 与 `ManagedCommandSandboxOwnerInternal`；
- transform admission owner：`ManagedNodeTransformOwnerInternal`；
- candidate/projection owner：Gitoxide mutation candidate authority；
- accepted truth owner：SQLite RuntimeEvents 与 workspace successor transaction；
- provider result owner：Runtime 的有界 immutable snapshot。

`managed_mutation_v3` 在 T1 前绑定 exact accepted head、workspace epoch、output path、entry bytes/hash、argv、
toolchain identity 与 execution profile。`managed_mutation_v2` 继续表达 Write/Edit 的参数形状；两种 RuntimeEvent
payload 都只允许同一个 canonical mutation execution profile v2 digest。payload protocol 用于区分 operation
proof 的字段，不再形成两套 execution authority，也没有 v1 digest 兼容路径。

## 3. 原子性边界

T1 前：

1. 验证当前 durable epoch/head；
2. materialize exact accepted tree 到 owner root；
3. 观察 entry identity并验证 `workspace_transform_v1` toolchain capability；
4. 冻结 v3 dispatch 与唯一 operation capability；
5. SQLite 在同一 T1 transaction 写 call、dispatch 与 exclusive mutation reservation。

T1 后：

1. Node 只读取 accepted materialization，只能写 scratch 中 owner 指定的 `MAKA_OUTPUT_PATH`；
2. `PATH=''`，child process 禁止，network restricted；
3. root process 完全退出后读取一个普通、非 symlink、最多 1 MiB 的 strict UTF-8 文件；
4. entry 前后 identity、output bytes 与 SHA-256 必须一致；
5. Gitoxide 把 exact output content 固化为 immutable candidate；
6. SQLite 原子提交 T2、successor fact、canonical head，并释放 reservation；
7. accepted ref 是可重建 projection，promotion 失败不得回滚已经接受的 Runtime truth。

## 4. 失败状态与收敛

- T1 前失败：删除 execution roots，不写 durable mutation；
- T1 后、process dispatch 前后失败：没有充分 terminal evidence 时保持 reservation 并 park；禁止 generic T2；
- transform 返回 no-change：提交 `no_workspace_change` terminal 并释放 reservation；
- candidate 已发布、SQLite 未接受：retry/recovery 重验 exact operation、profile、path 与 candidate receipt；
- SQLite 已接受、ref 未 promotion：只重放 projection，不重跑 Node transform；
- cleanup 失败：execution root 是 disposable artifact，不改变 accepted truth，由 maintenance 回收。

## 5. 平台矩阵

| 平台 | kernel 合同 | 产品 gate |
| --- | --- | --- |
| Linux | Node permission + enforcing OS sandbox；单一输出；Gitoxide/SQLite 收敛 | v4 real Host kill/reopen |
| macOS | 与 Linux 相同；路径先 realpath/canonicalize | v4 real Host kill/reopen |
| Windows | Node permission 限制 input/child；network 仍依赖外层 enforcing sandbox | 未有完整证据前 profile unavailable |

v1 只承诺 process-crash convergence，不承诺硬件断电持久性。任何平台无法证明 sandbox profile 时必须在 T1 前
报告 unavailable，不能回落到普通 Node、Bash 或用户 checkout。
