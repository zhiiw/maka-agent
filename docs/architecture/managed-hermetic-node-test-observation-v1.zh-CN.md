# Managed Hermetic Node Test Observation v1

## 范围

本切片在 M5.2 command sandbox 上增加最窄的 Node 测试执行能力。调用者只能给出 accepted input tree 中最多 64 个显式 `.js`、`.mjs` 或 `.cjs` 文件；不能传 package script、argv、environment、cwd、Node flags、可执行文件或 sandbox preference。

v1 不安装依赖，不读取系统 `PATH`，也不发现用户 checkout 的 `node_modules`。测试只能读取 accepted input 中已经存在的内容和 Node builtin。依赖供应链仍属于 M5.3，缺少依赖时测试会作为失败 observation 返回，不能静默借用 Host 或 source checkout 的依赖。

## 主要不变量

一次 `run_node_tests_v1` observation 必须满足：

- 复用 owner-bound `hermetic_observation_v1` toolchain capability；
- `SandboxManager` 必须提供 enforcing backend，`none` 或 unavailable 都 fail closed；
- Node `test.run()` 固定使用 `isolation: 'none'`，所有文件在一个短生命周期 helper 内串行导入，不派生 test child process；
- Node Permission Model 不授予 child process、worker、native addon、WASI 或 accepted input 写权限；
- accepted input 只读、scratch 可写、network restricted，OS sandbox 仍是安全 authority；
- 文件列表 canonical 排序、去重并有数量/路径/扩展名上限；每个测试文件在运行前记录大小与 SHA-256；
- stdout 只保留 exact JSON response，测试日志有界地转入 stderr；
- durable 候选结果不含 wall-clock duration、任意日志或异常文本，只含 Node version、输入文件 identity 和 pass/fail/skip/todo 计数；
- 没有报告任何 terminal test 的文件集合拒绝作为绿色结果。

Node 官方文档说明 `isolation: 'none'` 会把匹配文件导入当前 test runner 进程，不会生成每文件子进程。Node Permission Model 仍只作为 defense-in-depth；恶意测试的隔离责任属于 OS sandbox。

## Owner、原子性与失败状态

- Toolchain authority 拥有 executable/entrypoint identity。
- Command sandbox owner 拥有 input/scratch roots、profile、预算、spawn 和 process-tree lifecycle。
- Helper 拥有本次显式文件集合与 test runner；project test 不能改变 protocol 或获得新的 effect class。

本切片仍是 observation owner，不是 durable ledger owner：

- spawn 前失败：`clean unavailable`，没有测试副作用；
- spawn 后 timeout、abort、输出溢出、协议损坏：本次 observation 不可信，fail closed；
- 测试断言失败：helper 正常完成，返回 `failed > 0` 的可信 observation；
- helper 退出后：整个 in-process test world 被销毁，不保留 child process 能力。

后续 durable test settlement 必须在 T1 前冻结 accepted head、文件 identities、toolchain/profile 和 operation identity。T1 后若响应丢失，只能采用已持久化 observation 或在同一 immutable accepted input 上按明确的 replay-safe policy 重跑；不能回退到普通 Bash/npm。

## 平台矩阵

| 平台 | 当前证明 | 生产门槛 |
| --- | --- | --- |
| Linux | Node 24 protocol/permission 组合可运行 | Bubblewrap enforcing smoke + kill/reopen |
| macOS | Node 24 protocol/permission 组合可运行 | Seatbelt enforcing smoke + kill/reopen |
| Windows | Electron Node 24 真实 helper、无 child/input write、日志隔离已验证 | packaged AppContainer/Job broker smoke + kill/reopen |

在三平台 enforcing smoke 和 durable settlement 接入前，本能力保持 Draft，不对 Desktop 暴露普通 `Test` 工具。
