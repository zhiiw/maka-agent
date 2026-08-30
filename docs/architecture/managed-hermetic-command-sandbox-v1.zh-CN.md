# Managed Hermetic Command Sandbox v1

## 范围

本切片只建立 M5.2 的最窄命令 profile：读取一个 owner-provided accepted input tree，输出有界的文件 observation。它不是普通 Bash，不运行 package script，不允许 child process、worker、native addon、WASI、inspector、网络或凭据。

## 主要不变量

一次 `hermetic_observation_v1` 必须同时满足：

- 使用 M5.1 owner-bound toolchain capability；
- `SandboxManager` 必须选择真实 enforcing backend，`none` 或 unavailable 都 fail closed；
- input root 只读，scratch root 可写，network restricted；
- Node 24 Permission Model 作为 defense-in-depth，不授予 child process/worker/addon/WASI；
- environment 使用固定 allowlist，`PATH`、`NODE_OPTIONS`、HOME/TMP 不继承 Host；
- timeout 30 秒、stdout/stderr 各有硬上限，abort/overflow/非零退出统一失败；
- request/response 使用 exact JSON protocol，relative path 与 Node version 必须匹配。

Node 官方明确说明 Permission Model 是防止受信代码意外越权的 seat belt，不是对恶意代码的安全边界。因此本设计把 OS sandbox 作为必要 authority；Node flags 只做第二层限制，不能替代 platform sandbox。

## Owner 与失败状态

- Toolchain authority 拥有 executable/entrypoint identity。
- Command sandbox owner 拥有 profile、environment、预算、spawn 与 process-tree lifecycle。
- Helper 只拥有本次 request；调用者不能传 executable、argv、cwd、environment 或 sandbox preference。

在 command T1 接入以前，本切片没有 durable operation，也不声称可 Resume。spawn 前失败是 clean unavailable；spawn 后 timeout、abort、输出溢出或协议错误属于本次 observation 失败。后续 M5.4 在把 test/build 接入 durable ledger 时必须在 T1 前冻结 exact profile，并为 post-dispatch unknown outcome 定义 settlement。

## 平台矩阵

| 平台 | 当前状态 |
| --- | --- |
| Linux | 设计要求 Bubblewrap enforcing backend；production smoke 待补 |
| macOS | 设计要求 Seatbelt enforcing backend；production smoke 待补 |
| Windows | 设计要求 packaged AppContainer/Job broker；production smoke 待补 |

当前真实子进程测试证明 toolchain、Node permission flags、bounded protocol 和 process lifecycle 能组合运行；它使用注入的 enforcing-plan fixture，不替代三平台 OS sandbox 验收。因此该切片保持 Draft，直到 platform smoke 闭环。
