# Managed Workspace Rebaseline v1

## 主要不变量

source HEAD 变化时，旧 workspace epoch 永不原地换基线。只有显式、稳定的 rebaseline identity 才能创建同一 workspace 下的新 epoch；旧 epoch、accepted history、continuation 与 restore points 全部保留。

## Owner 与原子边界

- session owner 校验 rebaseline identity，并派生新的 epoch/instance/baseline version identity。
- Gitoxide admission 重新验证当前 source HEAD/tree。
- 现有 baseline authority 以 epoch-opened + baseline-accepted 原子 bundle 提交新 epoch。
- 同一 rebaseline identity 只允许 exact replay；source 再次漂移时 fail closed。

默认 epoch 的 identity 保持不变。rebaseline 只改变 epoch-scoped identity，repository/workspace identity 保持稳定。

## 平台与失败

三平台使用同一 SQLite/Gitoxide 合同。任何 import 或 baseline commit 失败都不会修改旧 epoch；import 成功但 SQLite 尚未提交时，现有 import exact-retry 协议负责收敛。v1 只承诺进程崩溃，不声明断电持久性。

