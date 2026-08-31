# Desktop accepted History v1

## 1. 主要不变量

Desktop 展示的 workspace history 必须是某一次 durable accepted head 的单一父链。UI 不从 projection、source checkout
或 Git log 猜测历史，也不能把读取历史变成 accepted-head mutation。

## 2. Owner

- SQLite workspace-version authority 拥有 immutable version records 与 current head；
- Gitoxide managed history owner 先捕获 current head，再沿 `parents[0]` 读取版本；
- Runtime Host 只为 `managed-coding-v2` session 打开 history owner；
- Desktop 只消费结构化、bounded 的 newest-first lineage；
- historical restore 仍由 time-travel/restore owner 执行，history query 没有文件系统写权限。

## 3. 一致性边界

读取不要求长事务锁住后续 head 推进。线性化点是第一次读取到的 exact head：后续 successor 可以合法提交，但本次
响应仍绑定旧 head，因为 version records immutable。owner 必须验证：

1. head 的 repository/workspace/epoch identity；
2. 首个 version 与 head 的 version/event/commit/tree 完全一致；
3. 每个 parent 位于同一 identity；
4. lineage 无循环、无断链；
5. 最多返回 50 项，并明确 `hasMore`。

任一条件失败都 fail closed，不返回部分历史。

## 4. 历史恢复

用户选择的 `workspaceVersionId` 必须由同一 epoch 的 version authority 重验。renderer 只提供 version ID 与稳定
`restoreId`；不能提供 commit/tree/path。恢复写入 Maka-owned isolated restore root，不 rewind current accepted
head，也不触碰 source checkout。响应丢失时复用同一个 ID。

## 5. 失败与回滚

- 普通 session、缺失 helper、history identity mismatch：fail closed；
- query 无 durable write，无需回滚；
- historical restore 的取消/崩溃使用 restore intent/orphan 协议收敛；
- 当前 accepted head 永远不因历史读取或恢复而改变。

## 6. 平台矩阵

lineage 读取只依赖 SQLite immutable records，Linux/macOS/Windows 合同一致。历史 materialization 继承 isolated
Restore v1 的平台保证。当前产品只展示最近 50 项；分页 cursor 与 Undo-as-successor 不属于 v1。
