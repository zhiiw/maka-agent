# Current-process Managed Toolchain Admission v1

## 1. 范围

本切片让 packaged Runtime Host 把当前 Electron Node 24 runtime 与固定 `managed-command-helper-main.js`
entrypoint 组合为 owner-bound managed toolchain capability。它不分发第二份 Node，不包含 npm，也不从 `PATH`
发现 executable。

新增 release artifact 只有：

- 编译后的单个 JavaScript entrypoint；
- 一个记录 entrypoint bytes/SHA-256、Node version、platform/arch 与 effect class 的有界 manifest。

因此包体增长是几十 KiB 量级，而不是另一份 Node runtime 的几十 MiB。

## 2. 信任边界

分发信任根仍是 Desktop 外层平台签名与安装包验证。相邻 manifest 不是独立密码学签名，也不能把任意未签名
development Electron 变成正式 release authority。

运行时 owner 只证明：

1. 当前进程确实是 Electron Node mode，Node major 为经过审计的 24；
2. packaged resources 中存在 exact v1 manifest；
3. entrypoint 位于 resources root 内，且 bytes/hash 与 manifest 完全一致；
4. 当前 `process.execPath` 是 bounded regular file；owner 在 admission 时计算其实际 bytes/hash；
5. executable 与 entrypoint identity 被写入 opaque capability，并在每次 invocation 前重新验证；
6. capability 只授予 `hermetic_observation_v1`，caller 不能增加 effect class。

v1 威胁模型不声称抵御已经能替换同一用户已安装、未经过平台验证的整个 App 与 manifest 的本地恶意进程。
这种能力等价于替换应用本身，属于 Desktop release/install authority 的边界。运行时 owner 负责防止 PATH、caller path、
单文件篡改和 admission 后 identity 漂移。

## 3. Owner、原子性与失败状态

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| Desktop release/install | 外层应用签名、resources 完整分发 | 单次 command operation |
| Current-process resolver | 当前 executable 与 packaged entrypoint observation | accepted tree、T1/T2 |
| Toolchain artifact authority | opaque invocation capability、重复 identity verification | sandbox、test result |
| Command sandbox owner | effect profile、process tree、input/scratch roots | release identity、durable outcome |

没有跨介质事务。toolchain capability 只在 executable/entrypoint 两次验证都成功后发布：

- manifest/platform/version 不匹配：profile unavailable；
- entrypoint 或 executable 在 observation 中变化：integrity mismatch，禁止 spawn；
- invocation 前 identity 漂移：capability 验证失败；
- 没有 capability：后续 product profile 必须在 T1 前 unavailable，禁止回退系统 Node/npm。

## 4. 平台矩阵

| 平台 | 当前承诺 | 仍需产品证据 |
| --- | --- | --- |
| Windows | packaged Electron Node 24 + exact entrypoint；不额外分发 Node | Authenticode installer lane + AppContainer/Job smoke |
| macOS | 相同 manifest/capability contract | signed/notarized app + Seatbelt smoke |
| Linux | protocol 可构建，但当前无正式 Desktop release trust root | 未来 signed package + Bubblewrap smoke |

本切片不直接改变 Session profile，也不把 `ManagedNodeTest` 暴露给 Desktop。产品接线必须在同一个 Host 能同时取得
Gitoxide、toolchain、sandbox 与 execution-root capabilities 时才创建版本化 managed-coding profile。
