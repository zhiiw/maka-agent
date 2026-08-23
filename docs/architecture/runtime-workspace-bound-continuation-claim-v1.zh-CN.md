# Workspace-bound continuation claim v1

## 状态与范围

本切片是 M3 的第一层，只证明一个主要不变量：

> 一个新的 continuation claim 只有在同一个 SQLite 写事务内同时匹配 immutable
> RuntimeEvent boundary 和当前 accepted managed-workspace head 时才能取得唯一所有权。

它是 API-only Draft。现有 Runtime planner、Runtime Host、Desktop、CLI 与 startup auto-resume
仍只消费 `continuation_claim_v1`；它们不会自动消费本切片新增的
`continuation_claim_v2`。生产接线必须在后续切片完成 Host 重验与 continuation-start 协议后再开放。

## Authority owner

事实 owner 分成三层：

1. RuntimeEvent ledger 拥有 provider replay 的 immutable prefix、event-seq high-water 与 manifest
   digest；
2. workspace RuntimeEvent authority 拥有 accepted epoch、version 与 current head；
3. SQLite continuation authority 在一个 `BEGIN IMMEDIATE` 事务中扫描以上两套事实，并创建唯一
   claim。

Caller 提交的 `workspaceBoundary` 只是待验证请求，不是事实源。SQLite 会从
`runtime_storage_root_binding`、workspace authority events 与可重建 projection 重新构造 exact
boundary，并进行深度相等比较。

## Identity protocol

`continuation_claim_v2` 绑定：

- ordered RuntimeEvent prefix segments；
- provider replay manifest；
- durable storage-root identity；
- repository/workspace/epoch/instance identity；
- exact accepted workspace version、accepted event 与 head revision；
- object format、commit/tree OID；
- materialization、workspace policy 与 execution-profile digest。

最终 `boundaryDigest` 使用独立 domain：

```text
maka.workspace-bound-continuation.v1
```

它不再等于 RuntimeEvent replay manifest digest。因此 target Run header 使用
`continuation_source_v3`，分别保存 composite boundary digest 与 replay manifest digest。

## Atomicity boundary

新 claim 的线性化点是 `runtime_continuation_claims` 的唯一行插入。插入前，在同一 SQLite 写事务内：

1. 校验全部既有 claim 行；
2. 重读 immutable RuntimeEvent prefix；
3. 从 canonical workspace RuntimeEvents 重建 accepted head；
4. 验证 workspace projections 与 canonical scan 一致；
5. 验证 storage-root binding；
6. 仲裁 boundary、source high-water 与 target identity 的唯一约束；
7. 插入 v2 claim。

事务提交前任一步失败，claim 不可见。精确重试优先读取已经提交的 claim，不要求 workspace head
仍停留在旧版本；否则一个合法 claim 会因后续 head 推进而失去幂等读取能力。

## Durable schema

Schema 15 将 `runtime_continuation_claims` 扩展为双协议表：

- v1 行必须没有 `workspace_boundary_json`；
- v2 行必须有 strict workspace-boundary JSON；
- schema 14 的 populated v1 行原样迁移；
- 新 capability `runtime_workspace_bound_continuation_authority@1` 缺失或版本未知时 fail
  closed。

现有 `runtime_continuation_authority_v1` API 仍只返回 v1。v2 使用独立的
`runtime_workspace_bound_continuation_authority_v1` API，防止尚未升级的 Runtime 静默消费新协议。

## Failure states and rollback

| Failure | Durable result | Retry behavior |
| --- | --- | --- |
| RuntimeEvent prefix missing、advanced 或 corrupt | 无 claim | 修复 ledger 后重新规划 |
| workspace root/head/version/profile 不匹配 | 无 claim | 必须从新 accepted head 重新规划 |
| target identity 已被其他 claim 占用 | 返回 conflict 或 fail closed | 不创建第二 owner |
| insert 后进程退出、事务未提交 | 无 claim | 重新取得 claim |
| exact v2 claim 已提交、响应丢失 | existing | 返回同一 immutable claim |
| persisted row/payload 被篡改 | fail closed | 人工修复，不猜测 |

本切片没有“回滚 workspace”的动作。claim 只取得 continuation 身份所有权，不修改 accepted
workspace head，也不启动 provider。

## Platform matrix

该切片只依赖 SQLite transaction/uniqueness 与 immutable RuntimeEvent scan，不新增平台文件系统原语。

| 平台 | 当前承诺 |
| --- | --- |
| Linux | SQLite claim 原子性与 strict decode；待 production-shaped M3 crash inventory |
| macOS | 同 Linux；尚未开放产品消费者 |
| Windows | 同 Linux；schema 14→15 populated migration 已覆盖 |

跨进程唯一性由 SQLite 写锁与唯一约束提供，不依赖进程内 mutex。

## 后续切片

M3 后续必须依次补齐：

1. Host 从 owner-issued managed-workspace capability 构造 boundary，禁止裸 JSON 自报；
2. continuation planner 在 claim 前重验 exact accepted head，并在 claim 后禁止 fallback；
3. v2 continuation-start 与 Run repair 只消费同一 claim；
4. production-shaped kill/reopen 测试先于 Desktop/CLI 与 startup auto-resume；
5. 产品入口明确选择 managed continuation，attached checkout 继续 fail closed。

