# Gitoxide managed product composition v1

## 主要不变量

只有显式选择 `managed-coding-v1` 的 Session，才能使用 packaged Gitoxide helper 打开 managed epoch，且该
profile 的工具上限只有 Write/Edit。普通 Session 不进入该数据面；helper 缺失或身份不匹配时，managed Session
在 provider dispatch 前失败，禁止从 PATH 发现 Git、回退 attached checkout 或改走普通文件工具。

## Owner 与权限

- product release owner 生成 helper binary、strict manifest 和锁定 Cargo graph 的第三方 notices；
- packaged-resource resolver 只接受 `process.resourcesPath` 内的固定路径，并绑定 platform、arch、bytes、SHA-256、
  protocol version 与完整 operation allowlist；
- artifact authority 将 release claim 转为 Runtime Host 私有的 invocation capability；调用者不能提交 executable path；
- managed session owner 从 source root 与 Session ID 派生 durable identity，并向 ToolRuntime 提供 owner-bound
  `admitManagedMutation`；
- ToolRuntime 保持 provider result 的唯一 owner，Gitoxide owner 只提交 terminal proof 与 durable successor。

外层已签名应用/安装包是 v1 的发布信任根。本合同防止误打包、manifest/helper 漂移、PATH 注入和普通 Session
误入 managed 数据面；不把本机恶意管理员或可任意改写完整安装目录的进程纳入密码学攻击模型。

## 原子性边界

1. Session header 在任何 T1 以前持久化 `managed-coding-v1`；
2. backend creation 在 provider dispatch 前要求 packaged helper capability，并打开 exact source epoch；
3. Write/Edit tool 在 T1 前取得 managed admission；
4. T1 后只允许 managed mutation state machine 提交 terminal outcome，禁止 generic T2 fallback；
5. Git candidate、SQLite successor 与 accepted ref projection 继续由下层 owner 按既有恢复协议收敛。

package build 的边界是：锁定 Cargo build成功后，复制到 `.generated`、计算 manifest、生成 notices，最后才允许
electron-builder 读取这些资源。最终包验证必须要求 binary、manifest 与 notices 同时存在。

## 失败状态与回滚

| 状态 | 行为 |
| --- | --- |
| dev/CLI Host 没有 packaged helper | 普通 Session 正常；managed Session 明确 `managed_workspace_profile_unavailable` |
| manifest 缺字段、operation list 漂移 | Host 不授予 capability |
| helper bytes/path/platform/arch 不匹配 | fail closed；不从 PATH 替代 |
| source admission/import 失败 | provider dispatch 前失败，不产生 managed T1 |
| T1 后进程退出 | 下层 SQLite/Gitoxide owner 按 durable evidence 恢复，不重跑 Write/Edit |

回滚本切片会删除 `managed-coding-v1` 产品入口和 packaged resource composition；现有普通 Session、SQLite 数据与
attached execution 行为不需要迁移。

## 平台能力矩阵

Linux、macOS、Windows 使用相同 manifest、artifact digest、operation allowlist 与 short-lived helper protocol。
正式 Desktop 当前打包 Windows x64 与 macOS arm64 helper；Linux workflow 继续证明 helper/owner 合同，但本切片
不新增 Linux Desktop 发布物。进程崩溃恢复由三平台 helper workflow 证明；硬件断电与恶意本机管理员不在 v1
新增承诺中。

## 非目标

- 不接入 npm dependency environment；纯 Write/Edit 不依赖 npm。
- 不向 managed profile 暴露 Bash、Read、Glob、Grep 或 attached filesystem worker。
- 不自动迁移普通 Session，也不把 managed capability 当作 resident Host 的隐式 fallback。
