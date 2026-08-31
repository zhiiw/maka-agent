# Managed Hermetic Node Test Observation v1

## 范围

本切片在 M5.2 command sandbox 上增加最窄的 Node 测试执行能力。调用者只能给出 accepted input tree 中最多 64 个显式 `.js`、`.mjs` 或 `.cjs` 文件；不能传 package script、argv、environment、cwd、Node flags、可执行文件或 sandbox preference。

v1 不安装依赖，不读取系统 `PATH`，也不发现用户 checkout 的 `node_modules`。测试只能读取 accepted input 中已经存在的内容和 Node builtin。依赖供应链仍属于 M5.3，缺少依赖时测试会作为失败 observation 返回，不能静默借用 Host 或 source checkout 的依赖。

## 主要不变量

一次 `run_node_tests_v1` observation 必须满足：

- 复用 owner-bound `hermetic_observation_v2` toolchain capability；
- `SandboxManager` 必须提供 enforcing backend，`none` 或 unavailable 都 fail closed；
- 已验证 helper 在一个短生命周期沙箱根进程内直接导入精确文件，由 Node 内建 harness 运行注册的 tests；不启用文件 discovery、不调用 programmatic `run()`、不派生 test child process，并固定使用 `--test-force-exit`；
- Node Permission Model 不授予 child process、worker、native addon、WASI 或 accepted input 写权限；
- accepted input 只读、scratch 可写、network restricted，OS sandbox 仍是安全 authority；
- 文件列表 canonical 排序、去重并有数量/路径/扩展名上限；每个测试文件在运行前记录大小与 SHA-256；
- Node 内建 TAP reporter 是唯一 test result surface；Host 只解析唯一完整的 terminal summary，stdout/stderr 仍分别受 64 KiB 上限约束；
- durable 候选结果不含 wall-clock duration、任意日志或异常文本，只含 Node version、输入文件 identity 和 pass/fail/skip/todo 计数；
- 没有报告任何 terminal test 的文件集合拒绝作为绿色结果。

Node 的普通 `node:test` 模块会在当前进程运行已注册 tests；这里由 owner 固定的 helper 顺序导入精确文件，完全不开放 Node 的文件 discovery 或 process-isolation runner。`--test-force-exit` 让沙箱根进程在 reporter 完成后销毁测试遗留的 event-loop handles。Node Permission Model 仍只作为 defense-in-depth；测试代码的文件、网络和进程隔离责任属于 OS sandbox。

## Owner、原子性与失败状态

- Toolchain authority 拥有 executable/entrypoint identity。
- Command sandbox owner 拥有 input/scratch roots、profile、预算、spawn 和 process-tree lifecycle。
- Command sandbox owner 固定 test runner CLI 与显式文件集合；project test 不能改变 runner flags、结果协议或获得新的 effect class。Identity helper 只在执行前后证明输入文件没有变化。

本切片仍是 observation owner，不是 durable ledger owner：

- spawn 前失败：`clean unavailable`，没有测试副作用；
- spawn 后 timeout、abort、输出溢出、协议损坏：本次 observation 不可信，fail closed；
- 测试断言失败：runner 以固定失败退出码完成，Host 从完整 TAP summary 生成 `failed > 0` observation；
- runner 退出后：整个 in-process test world 被销毁，不保留 child process 能力。

后续 durable test settlement 必须在 T1 前冻结 accepted head、文件 identities、toolchain/profile 和 operation identity。T1 后若响应丢失，只能采用已持久化 observation 或在同一 immutable accepted input 上按明确的 replay-safe policy 重跑；不能回退到普通 Bash/npm。

## 平台矩阵

| 平台 | 当前证明 | 生产门槛 |
| --- | --- | --- |
| Linux | Node 24 protocol/permission 组合可运行 | Bubblewrap enforcing smoke + kill/reopen |
| macOS | Node 24 protocol/permission 组合可运行 | Seatbelt enforcing smoke + kill/reopen |
| Windows | v1 不签发 Electron Node toolchain capability | 引入独立校验的 standalone Node artifact 后，再运行 AppContainer/Job kill/reopen |

Linux/macOS 已运行 enforcing Host kill/reopen；Windows 在 T1 前明确返回
`managed_workspace_profile_unavailable`，禁止 PATH/非沙箱 fallback。在 standalone Node authority 交付前，Windows
Desktop 不暴露 managed Node test 能力。
