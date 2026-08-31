# Managed Hermetic Command Sandbox v1

## 范围

本切片只建立 M5.2 的最窄命令 profile：读取一个 owner-provided accepted input tree，输出有界 observation。初始操作是单文件 identity；后续 `run_node_tests_v1` 在同一 profile 内运行显式、无 provisioning 的 Node tests。它不是普通 Bash，不运行 package script，不允许 child process、worker、native addon、WASI、inspector、网络或凭据。

## 主要不变量

一次 `hermetic_observation_v1` 必须同时满足：

- 使用 M5.1 owner-bound toolchain capability；
- `SandboxManager` 必须选择真实 enforcing backend，`none` 或 unavailable 都 fail closed；
- input root 只读，scratch root 可写，network restricted；
- Node 24 Permission Model 作为 defense-in-depth，不授予 child process/worker/addon/WASI；
- environment 使用固定 allowlist，`PATH`、`NODE_OPTIONS`、HOME/TMP 不继承 Host；
- timeout 30 秒、stdout/stderr 各有硬上限，abort/overflow/非零退出统一失败；
- identity helper 使用 owner 固定的 positional operation 与 portable paths，并只在 stdout 返回 exact JSON
  response；Node test 由同一个沙箱根进程中的固定 helper import profile 执行，Host 只接受有界、完整的 TAP
  terminal summary，relative path、显式测试文件集合与 Node version 必须匹配。

Node 官方明确说明 Permission Model 是防止受信代码意外越权的 seat belt，不是对恶意代码的安全边界。因此本设计把 OS sandbox 作为必要 authority；Node flags 只做第二层限制，不能替代 platform sandbox。

## Owner 与失败状态

- Toolchain authority 拥有 executable/entrypoint identity。
- Command sandbox owner 拥有 profile、environment、预算、spawn 与 process-tree lifecycle。
- Identity helper 只拥有本次文件观察 request；Node test runner 只拥有本次显式测试文件集合。调用者不能传 executable、argv、cwd、environment、Node flags 或 sandbox preference。

在 command T1 接入以前，本切片没有 durable operation，也不声称可 Resume。spawn 前失败是 clean unavailable；spawn 后 timeout、abort、输出溢出或协议错误属于本次 observation 失败。后续 M5.4 在把 test/build 接入 durable ledger 时必须在 T1 前冻结 exact profile，并为 post-dispatch unknown outcome 定义 settlement。

## 平台矩阵

- Linux：以 bubblewrap + 当前发布 Electron Node-mode runtime 证明 `hermetic_observation_v1`。
- macOS：以 Seatbelt + 当前发布 Electron Node-mode runtime 证明 `hermetic_observation_v1`。
- Windows：v1 明确不可用。Electron.exe 在 AppContainer 内无法形成已证明的短生命周期 Node
  command owner；Host 因而不签发 capability，并在 T1 前返回
  `managed_workspace_profile_unavailable`。后续支持必须引入独立校验的 standalone Node artifact，禁止从
  `PATH` 借用系统 Node 或退化成非沙箱执行。

Linux/macOS 的 production-shaped Host gate 已使用真实 OS sandbox、发布形态 runtime 与 helper 执行并在 Host
kill/reopen 后收敛。Windows gate只证明 fail-closed availability，不把缺少 standalone Node authority 误报成测试
能力。
