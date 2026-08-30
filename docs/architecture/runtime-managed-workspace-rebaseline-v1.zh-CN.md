# Managed Workspace Rebaseline v1

## 主要不变量

source HEAD 变化时，旧 workspace epoch 永不原地换基线。只有显式、稳定的 rebaseline identity 才能创建同一 workspace 下的新 epoch；旧 epoch、accepted history、continuation 与 restore points 全部保留。

## Owner 与原子边界

- session owner 校验 rebaseline identity，并派生新的 epoch/instance/baseline version identity。
- Gitoxide admission 重新验证当前 source HEAD/tree。
- 现有 baseline authority 以 epoch-opened + baseline-accepted 原子 bundle 提交新 epoch。
- 首个 baseline 同事务写入 `maka.workspace.epoch_activated` root fact；后续 rebaseline 通过独立的
  activation fact 对 active epoch 做 compare-and-set。`runtime_workspace_active_epochs` 只是可从事实重建的
  SQLite projection。
- 同一 rebaseline identity 只允许 exact replay；source 再次漂移时 fail closed。

默认 epoch 的 identity 保持不变。rebaseline 只改变 epoch-scoped identity，repository/workspace identity 保持稳定。

## 平台与失败

三平台使用同一 SQLite/Gitoxide 合同。任何 import 或 baseline commit 失败都不会修改旧 epoch；import 成功但
activation 尚未提交时，新 epoch 保持 dormant，普通 reopen 仍选择旧 active epoch。activation 事务内崩溃会整体
回滚；事务提交后响应丢失，exact retry 返回同一 active epoch。真实子进程 kill/reopen 测试覆盖事务内与提交后两个
边界。

| 平台 | v1 承诺 |
| --- | --- |
| Linux | SQLite process-crash rollback/reopen；Gitoxide epoch identity 相同 |
| macOS | 与 Linux 相同；路径 observation 先 canonicalize |
| Windows | SQLite process-crash rollback/reopen；文件占用不改变 active-epoch truth |

v1 只承诺进程崩溃，不声明硬件断电持久性。Desktop Rebaseline 按钮是下一切片；本切片只关闭“重启后当前 epoch
回退”的 durable authority 缝隙。
