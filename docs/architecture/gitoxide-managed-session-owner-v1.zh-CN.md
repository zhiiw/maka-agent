# Gitoxide managed session owner v1

## 主要不变量

一个显式 managed session 只能从一次受权的 source observation 打开一个 durable workspace epoch。source
import、SQLite baseline 与后续 Write/Edit owner 必须绑定同一 source commit/tree、helper artifact、managed
tree policy 和 session identity。

## Owner 与权限

- Gitoxide repository admission owner 观察 source HEAD，并签发不可伪造的 admission capability；
- Gitoxide import owner 只从该 capability 导入 exact source commit；
- session owner 从 canonical source root 与 session ID 派生 repository/workspace/epoch/instance/version ID，调用者
  不能自报 durable identity；
- Execution Stores baseline capability 各自持有一个 process-local imported-repository verifier。SQLite writer
  只接收 verifier 返回的 baseline descriptor，不接受裸 commit/tree/epoch；
- Write/Edit owner 只在 durable baseline 成立后签发 mutation admission。

## 原子性与恢复

Git repository import 与 SQLite baseline 不能组成一个物理事务。v1 使用以下有序提交：

1. Gitoxide 将 exact source HEAD 导入 Maka-owned bare repository，并发布 `refs/maka/accepted`；
2. SQLite 原子提交 epoch、baseline version、head 和所有投影；
3. session owner 创建 Write/Edit owner，并验证 accepted ref 与 durable head 一致。

进程若在 1 与 2 之间退出，新 owner重新观察 source，并只允许 exact source commit/tree。Gitoxide import 做 exact
retry，Execution Stores 为新的 process-local proof 重新签发 baseline capability，SQLite 再做 exact retry。不会导入
另一个 source HEAD，也不会覆盖已接受 epoch。

## 失败状态

| 状态 | 行为 |
| --- | --- |
| source 不是 policy-v3、SHA-1 repository | T1/baseline 前拒绝 |
| source 在已打开 epoch 后前进 | fail closed；不会静默 rebaseline |
| helper artifact digest 或 workspace policy 改变 | fail closed；新能力必须显式开新 epoch |
| import 已完成、baseline 未提交 | exact import + baseline retry |
| epoch/head/version 只有部分或彼此不一致 | corruption，拒绝签发 Write/Edit owner |
| accepted ref 落后 durable successor | Write/Edit projection recovery 只重放 candidate/ref CAS |

## 平台能力矩阵

Linux、macOS、Windows 使用同一个 short-lived Gitoxide helper、source admission、import 和 SQLite baseline
协议。三平台 workflow 会在 import 后直接终止子进程，并由新进程证明 exact retry。该合同只覆盖进程崩溃；
macOS/Windows 的硬件断电持久性不由本切片扩大承诺。

## 当前交付边界

本切片是 packaged/Host composition 的 session owner。它不从 PATH 发现 helper，不接受公开 helper 路径，也不
自动把普通 Desktop session 升级成 managed session。发布资源 authority 与显式产品入口由后续组合切片提供。
