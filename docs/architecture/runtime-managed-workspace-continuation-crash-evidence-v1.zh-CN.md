# Managed workspace continuation crash evidence v1

> 状态：stacked Draft。依赖 M3.2 workspace-bound continuation admission；不启用 Desktop/CLI 自动续跑。

## 主要不变量

`managed-coding-v1` continuation 的 durable start 一旦提交，Runtime Host 崩溃后只能基于同一条 `ContinuationClaimV2` 和同一个 Gitoxide accepted head 收敛。重启不得重新调用 provider，也不得回退到 v1 continuation authority。

## Owner 与原子性边界

- SQLite RuntimeEvent ledger 拥有 continuation claim、start fact 和 accepted workspace head。
- Gitoxide helper 只重验 claim 绑定的 commit/tree；它不决定是否重新执行 provider。
- Runtime Host startup recovery 读取 v2 claim state，并在 provider dispatch 已不可判定时停在 `continuation_started_indeterminate`。
- `openInteractiveExecutionStoresForWrite()` 的受限 RuntimeEvent facade 显式暴露 v2 capability 和唯一的一组 v2 writer；不存在旁路 writer。

原子性边界是 `commitWorkspaceBoundContinuationStart()` 的 SQLite transaction。该 transaction 之前可以安全重试 admission；提交之后不得根据进程内状态推断 provider 是否执行。

## 失败状态与回滚

| 状态 | 处理 |
| --- | --- |
| claim/start 绑定的 workspace head 与当前 accepted head 不一致 | fail closed；不启动 provider |
| durable start 已存在、provider outcome 不可证明 | park 为 `continuation_started_indeterminate` |
| v2 authority/capability 缺失 | fail closed；禁止回退 v1 |
| Gitoxide helper/manifest 不可验证 | managed continuation unavailable；不启动 provider |

这里没有“回滚 durable start”。它是不可变事实。人工终止、未来 provider reattach 或其他恢复策略必须另外提交新的明确事实，不能改写旧 start。

## Production-shaped crash proof

三平台 gate 使用与当前源码匹配的 release Gitoxide helper，并完成下面的真实进程序列：

1. 创建 SHA-1 source repository 和 `managed-coding-v1` Session；
2. 通过真实 Gitoxide helper 创建并重验 accepted baseline；
3. 启动真实 Runtime Host，提交 workspace-bound claim 与 durable start；
4. 在 `after_continuation_start_committed` 杀死整个 Host 进程；
5. 使用同一 storage root 与 helper 启动新 Host；
6. 验证 claim 仍绑定原 commit/tree/revision，恢复结果为 `continuation_started_indeterminate`；
7. 验证 provider invocation log 始终为空。

这项测试有意不声称可以恢复 provider 的网络执行。它证明的是“未知时不重发”，不是 bit-exact provider continuation。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | 真实 helper、Runtime Host kill/reopen、0 次 provider replay |
| macOS | 真实 helper、Runtime Host kill/reopen、0 次 provider replay |
| Windows | 真实 helper、Runtime Host kill/reopen、0 次 provider replay |

证据由 `.github/workflows/gitoxide-helper-admission.yml` 的三平台 matrix 持续执行。CI 绿只证明这些已枚举边界；它不扩大到断电恢复、provider reattach 或 Desktop 自动续跑。

