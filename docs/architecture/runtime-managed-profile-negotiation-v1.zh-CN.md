# Managed execution profile negotiation v1

## 1. 主要不变量

> Desktop 必须在创建 Session、持久化 tool profile 和任何 managed T1 之前，从当前 resident Runtime Host
> 的实际 capability set 中冻结一个精确 execution profile；T1 后不得因平台、打包资源或 sandbox 不可用而
> 静默降级。

这个协议只决定“当前 Host 能提供什么”，不决定某次工具是否成功。`managed-coding-v2` 代表完整 accepted-world
Read/Glob/Grep/Write/Edit；`managed-coding-v2` 在 v1 上增加受控 Node test observation。

## 2. Owner 与权限边界

- capability owner：Runtime Host production composition。它只能从已经打开并验证的 Gitoxide helper capability
  与 managed Node test declaration 推导 profile；PATH、renderer 参数和相邻 manifest 都不能增加能力；
- selection owner：Desktop main。renderer 只表达普通 workspace task/product intent，不能直接签发内部 profile；
- durable owner：Session create writer。Desktop 选定的 profile 作为 Session 创建输入持久化，后续 continuation
  只能采用同一 profile；
- execution owner：各 tool owner。它们仍需逐次验证 accepted head、workspace epoch 和具体 sandbox capability。

## 3. 原子性边界

Host 通过 `host.execution-profiles.query` 返回严格、去重、按版本排序的闭合集合。Desktop 在同一次 Session create
处理内完成：

```text
resolve workspace target
  -> query resident Host profiles
  -> choose highest supported profile
  -> create Session with exact profile
```

profile query 与 Session create 不是跨进程事务；安全性来自 Host compatibility epoch 和 resident Host election：
不兼容 Host 不能通过连接握手，且 Session create writer 会永久记录选择结果。查询失败或集合为空时，不创建
Session，也不回退 attached execution。

## 4. 失败状态与收敛

- Host 未 Ready、正在 drain 或查询失败：Session 尚未创建，调用者可在连接恢复后安全重试；
- 返回未知、重复或乱序 profile：protocol decoder fail closed；
- 只有 v1：创建 v1 Session；
- v1 + v2：创建 v2 Session；
- 空集合：明确报告 managed coding unavailable；
- Session 已创建后 v2 capability 消失：不得改写为 v1；该 Run/continuation park 或报告 profile unavailable。

这里没有 rollback 数据：线性化点是 Session durable create。此前失败没有 Session；此后只能遵守已冻结 profile。

## 5. 平台矩阵

| 平台 | v1 | v2 | 当前保证 |
| --- | --- | --- | --- |
| Linux | 可用 | Bubblewrap 证明后可用 | production-shaped Host crash gate |
| macOS | 可用 | Seatbelt 证明后可用 | production-shaped Host crash gate |
| Windows | Gitoxide kernel 可用 | 当前完整 profile 不可用 | Host 发布空集合；不会降级到旧 profile |

Windows 的限制是当前 sandbox capability 合同，不是 Gitoxide/Write/Edit 的限制。将来加入可证明的 Windows
managed Node sandbox 时，由 composition 直接发布 canonical v2；协议和 Desktop selection 不需要改变。

## 6. 测试合同

1. protocol 拒绝未知、重复、乱序 profile；
2. Host kernel 返回 composition 实际集合；
3. Desktop 只接受 exact v2，空集合或旧 Draft profile 时拒绝创建；
4. packaged managed-coding-v2 gate 在具备完整 sandbox 的平台观察 v2，否则观察空集合；
5. compatibility epoch 阻止不了解该冻结协议的旧 Client/Host 混用。
