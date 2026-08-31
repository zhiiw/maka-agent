# Managed hermetic Node command kernel v1

status: enabling infrastructure

milestone: M5 foreground command loop

## 1. 主要不变量

一次 `ManagedNodeRun` 只能把一个 immutable accepted Git tree 中的显式 `.js`、`.mjs` 或 `.cjs`
入口作为受限 Node 进程执行。入口路径、exact argv、accepted head、entry bytes/hash、toolchain identity 与
execution profile 必须在 T1 前由 admission owner 冻结；T1 后禁止切换到普通 Bash、`PATH`、source checkout、
依赖发现或 generic tool boundary。

本切片只建立 kernel 与 admission，不让现有 Host 宣告 `managed-coding-v3`。下一产品组合切片必须同时提供
packaged toolchain claim、Host profile negotiation 与 production-shaped crash test，才允许 Desktop 创建 v3
Session。

## 2. Owner 与权限

- accepted content owner：Gitoxide managed session；
- execution-root owner：Storage root 下的短生命周期 input/scratch lease；
- toolchain owner：opaque managed-toolchain invocation capability；
- process owner：`ManagedCommandSandboxOwnerInternal`；
- durable fact owner：Runtime T1/T2；
- provider result owner：Runtime 捕获的 strict bounded snapshot。

模型只能提交：

```ts
{
  entryPath: string;
  args?: string[];
}
```

模型不能提交 executable、cwd、environment、Node flags、sandbox preference、dependency root、timeout、网络策略
或输出上限。

## 3. 原子性边界

T1 前：

1. 读取 accepted boundary；
2. materialize exact accepted commit/tree 到 owner root；
3. 观察 entry identity；
4. 验证 Node 24 toolchain capability；
5. 冻结 entry 与 argv；
6. 持久化 `managed_observation_v3`。

T1 后：

1. 只在 read-only accepted input + disposable scratch 上启动一个 root process；
2. `PATH=''`，不授予 child process，外层 sandbox 要求 `network: restricted`；
3. entry 执行前后 identity 必须相同；
4. stdout/stderr 各最多 32 KiB，完整 provider result 最多 64 KiB；
5. Runtime 提交 T2 后才发布 live result。

非零 exit code 是命令 observation 的数据，不是 authority failure。timeout、abort、sandbox unavailable、输出溢出、
entry drift 或 toolchain drift 都是未取得合法 observation 的失败。

## 4. 失败与回滚

- T1 前失败：删除 input/scratch，拒绝 dispatch；
- T1 后、T2 前失败：保留 durable T1，按 replay-safe observation 恢复；命令不能写 accepted content 或外部世界；
- T2 后响应丢失：采用 durable outcome，不重新发布第二个事实；
- cleanup 失败：不改变 durable outcome，后续由 execution-root maintenance 回收 disposable roots。

## 5. 平台矩阵

| 平台 | kernel | product availability |
| --- | --- | --- |
| Linux | Node permission + enforcing OS sandbox | 待 v3 Host crash gate |
| macOS | Node permission + enforcing OS sandbox | 待 v3 Host crash gate |
| Windows | Node permission 可限制输入写入/child；网络仍依赖外层 sandbox | 在完整网络隔离证据前不得宣告 v3 |

没有平台证据时必须报告 profile unavailable，禁止回落到普通 Node/Bash。
