# Desktop Managed Lifecycle Maintenance v1

## 主要不变量

Desktop 的正常 Review 读取不能隐式变成写操作。accepted review 成功后，Desktop 另外发送一个显式 command；该 command 只调用 managed session 的 GC owner。v2 可处理当前 epoch 固定 `orphans/` 根下已过期的 restore orphan，以及不属于当前 accepted mutation 或 active T1 reservation 的过期 mutation candidate receipt/ref。

accepted head、历史版本、published ref、source branch、active restore 和 continuation evidence 不属于该 command 的删除集合。

## Owner 与边界

- Desktop：每个 accepted revision 最多自动请求一次 maintenance；不提供路径、期限或删除上限。
- Runtime Host coordinator：固定策略为 24 小时和单批最多 32 项。
- GC owner：验证目录身份、rename 到 `.gc-*` tombstone，再执行删除；
- candidate retention owner：从 SQLite accepted head 与 active mutation 读取保留根；
- Gitoxide helper：在 accepted ref 仍等于冻结 head 时，对 exact operation candidate ref 做 CAS 删除。
- 唯一可恢复边界：orphan 到 tombstone 的 rename；真实 child-process kill/reopen 测试已覆盖。

Review query 和 maintenance command 使用不同 protocol operation。maintenance 失败不会伪造 Review 失败，也不会改变 accepted truth；下一次 Review 可再次请求。

## 静默 UX

正常清理不弹窗、不要求用户选择。用户需要交互的仍只有 park、冲突、权限和显式 Publish/Restore/Rebaseline。清理失败只意味着保守保留更多 Maka-owned artifact，不影响 Resume。

## 平台矩阵

Linux、macOS 和 Windows 使用相同 tombstone 协议。candidate ref 删除后、receipt rename 前崩溃时，重试把缺失的 exact ref 视为 replay success；receipt tombstone 后崩溃时，新进程只清理 tombstone。Windows 文件占用导致删除失败时 tombstone 保留到下一轮；所有平台都不承诺硬件断电持久性，也不进行 Git object reachability GC、pack compaction 或 history-candidate 回收。
