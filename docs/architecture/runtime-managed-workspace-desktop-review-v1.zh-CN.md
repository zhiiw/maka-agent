# Managed Workspace Desktop Review v1

## 目标

Managed Session 的 Review 面板只展示同一 workspace epoch 的 source baseline 与 accepted head
之间的差异。它不得读取 attached checkout，也不得在 Host/Gitoxide 不可用时静默退回本机
`git diff`。

普通 Session 保留既有 checkout Review；该兼容路径不获得 managed workspace 的事实权威。

## Owner 与边界

```text
SQLite workspace boundary
        +
Gitoxide accepted repository
        ↓
GitoxideManagedReviewOwner
        ↓
managed-workspace.review.query
        ↓
Desktop git-review:read
```

- SQLite/managed session owner 决定 baseline commit/tree 与 accepted commit/tree。
- 短生命周期 Gitoxide helper 在一个 repository view 中比较两棵 immutable tree。
- Runtime Host 生成有界 unified diff，并验证文件统计与传输 envelope。
- Desktop IPC 仅负责按 Session profile 路由；managed profile 没有 checkout fallback。

该操作是只读 query，不创建新的 durable fact。它的线性化点是 review owner 读取并验证的同一组
baseline/accepted boundary；helper 返回值与该 boundary 不一致时整次读取失败。

## 有界性

- 最多返回 200 个 changed path；更多路径设置 `truncated`。
- 单侧文本最多 32 KiB；二进制、超限或非 UTF-8 文件只返回不可展开的差异说明。
- helper 同次比较最多携带 384 KiB 文本；Host 输出文件集合最多编码 512 KiB。
- Runtime Host protocol 结果上限为 640 KiB，低于统一 768 KiB frame 上限。

## 失败与回滚

- Session 不存在：`not_found`。
- Session 不是 managed profile：`invalid_request`。
- packaged helper authority 不存在：`operation_unavailable`。
- source/accepted boundary 漂移、helper proof 冲突或存储不可读：fail closed；Desktop 显示加载失败。
- query 不写 durable state，因此不需要数据回滚；重试必须重新读取完整 boundary。

## 平台能力矩阵

| 平台 | 承诺 |
| --- | --- |
| Linux | packaged helper identity 验证后读取 accepted tree；不调用系统 Git |
| macOS | 同 Linux；不依赖 `/var`/`/private/var` checkout 别名 |
| Windows | 同 Linux；managed path 使用 Git canonical `/` 表示，不调用 PATH 上的 Git |

三平台都只承诺 immutable accepted-tree Review。普通 Session 的 checkout Review 仍沿用现有平台
Git 行为，不属于本协议。
