# Gitoxide repository admission v1

状态：验证切片，尚无 Desktop/CLI/M2 生产消费者；只能保持 Draft。

## 1. 主要不变量

本切片只证明一个不变量：

> 在任何 managed-workspace durable mode 或 T1 被选择前，Git backend owner 必须用隔离的
> Gitoxide repository handle 判定 object format；只有 SHA-1 repository 能取得 admission
> 结果，SHA-256 和未来未知格式都以稳定错误 fail closed，且不得回退到系统 Git。

它不证明 clone、fetch、worktree、candidate、projection、redo 或 Write/Edit 恢复能力。现有
`GitWorkspaceService` 尚未切换到这个 broker。

## 2. Owner 与边界

| 项目 | v1 约束 |
| --- | --- |
| owner | `maka-gitoxide-broker` 进程 |
| 输入 | 单个、最大 64 KiB、strict JSON `inspect_repository` 请求 |
| 配置边界 | `gix::open::Options::isolated()` + strict config；不读取 system/user/environment Git config |
| capability 发行 | 当前只返回只读的 repository observation，不发行可写 capability |
| 原子性边界 | 无跨介质事务；单次进程请求只观察一次 repository handle |
| 成功 | SHA-1 + exact HEAD commit OID + exact HEAD tree OID |
| policy failure | SHA-256/未知 hash kind 返回 exit 2 + `unsupported_object_format` |
| operational failure | malformed request、open/head 失败返回 exit 1 + 稳定 broker error code |
| rollback | 只读操作，无需回滚 |

协议用 `supportedObjectFormats: ["sha1"]` 表达当前能力。未来 SHA-256 支持必须作为显式的新
backend capability 加入；不能把当前 rejection 悄悄改为 system-Git fallback。

## 3. 为什么同时编译 SHA-256 feature

Gitoxide 的 `sha256` Cargo feature 在 v1 中只用于识别 repository format，从而给出确定的策略
拒绝。它不代表 Maka 支持 SHA-256 repository。Gitoxide 当前的 SHA-256 clone/fetch/完整仓库
生命周期仍不成熟，因此 v1 不对其发行 capability。

## 4. 测试与工具链

- 普通 `npm test`、TypeScript workspace 测试和最终用户运行不要求安装 Rust。
- 修改 broker 时才运行 `npm run test:gitoxide`（等价于对独立 manifest 运行 locked Cargo test）。
- 独立 GitHub Actions lane 在 Linux、macOS、Windows 上构建同一份源码并运行协议测试。
- 测试先用 Git CLI 创建真实 SHA-1/SHA-256 fixture，随后清空 broker 子进程的 `PATH`；因此
  broker 若尝试调用系统 Git，测试会失败。
- `Cargo.lock` 是 broker source/build identity 的一部分，必须提交。

Gitoxide `gix@0.86.0` 使用 `MIT OR Apache-2.0`；当前 locked Cargo closure 的许可元数据审计
未发现 GPL/AGPL 依赖。Windows x64 本地未专门 strip 的 release probe 为 7,837,696 bytes；
该数字只用于评估量级，不是最终三平台打包 SLO。

## 5. 平台能力矩阵

| 平台 | 当前承诺 | 尚未承诺 |
| --- | --- | --- |
| Linux | SHA-1 inspect；SHA-256 stable reject；无 system-Git fallback | production packaging、sandbox、crash recovery |
| macOS | 同 Linux | code signing/notarization、production packaging |
| Windows | 同 Linux | Authenticode、AppContainer/job owner、production packaging |

只有三平台 CI 证据全部建立后，才可把上表中的“当前承诺”视为持续验证；本地 Windows green
不能替代 macOS/Linux 证据。

## 6. 后续切片

下一切片最多选择一个主要不变量：Host 验证 broker binary identity 后，把上述 observation
转换成 T1 前的 opaque Git backend capability。对象写入、ref CAS 和 fresh projection 应继续
各自按 owner/崩溃边界拆分，不能在 admission PR 中顺手接入完整 M2 数据面。
