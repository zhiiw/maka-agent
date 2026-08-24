<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Gitoxide mutation candidate owner v1

状态：M2.2 stacked Draft。尚未接入 Write/Edit；M2.4 是首个生产消费者。

## 1. 主要不变量

> M2.2 只能从精确 accepted base 生成 operation-bound immutable candidate；发布 candidate 不得推进
> accepted ref，也不得写 SQLite accepted truth。

- owner：Runtime Host 内部的 Gitoxide candidate authority；
- owner 前置能力：创建 authority 必须消费仍有效的 `interactive/write` storage-root lease；初始化、
  receipt 锁与每次 capture 都在该 lease 内运行，不能由裸路径自行声明 storage root；
- 原子边界：Gitoxide 对确定性 `refs/maka/candidates/<operation-digest>` 执行 exact-base ref CAS；
- 失败状态：accepted base 漂移、candidate ref 冲突、receipt 损坏或身份不一致均 fail closed；
- 回滚：ref 已发布、receipt 未写时，重启通过 exact retry 补齐同一 receipt；未被 M2.1 接受的 candidate
  保持 orphan，后续由受证明的 discard/GC owner 回收。

## 2. Owner 与事实权威

```text
SQLite RuntimeEvents / workspace head (M2.1)   唯一 accepted truth
                     │ exact base
                     ▼
Gitoxide managed repository capability
                     │
                     ▼
prepare_candidate(base, path, content)
                     │
                     ├─ refs/maka/accepted       不变
                     └─ refs/maka/candidates/*   immutable candidate
                                      │
                                      ▼
                             durable receipt（派生证据）
```

receipt 不是第二事实源。新进程不会仅凭 JSON 恢复 capability，而会：

1. 从 storage-root 与 workspace identity 派生 repository/receipt 路径；
2. 用短生命周期 helper 重验 accepted ref 的 exact commit/tree；
3. 对相同 operation 执行 deterministic exact retry；
4. 将 ref/object observation 与 strict receipt 全字段比较；
5. 比较成功后才签发新的 owner-bound opaque candidate capability。

## 3. Crash / concurrency matrix

| 故障点 | Durable 状态 | 恢复 |
|---|---|---|
| candidate object 写入前 | accepted ref 不变，无 receipt | 重新计算 |
| candidate ref 发布前 | accepted ref 不变，无 receipt | 重新发布同一 ref |
| candidate ref 后、receipt 前 | candidate ref 存在 | exact retry 后补 receipt |
| receipt temp 写入中 | ref 存在，临时文件可能存在 | 忽略非权威 temp，重写 receipt |
| receipt rename 后响应丢失 | ref + receipt 完整 | 全字段重验并返回新 capability |
| 两进程同时 capture | 同一 receipt OS lock + ref CAS | 一个发布，另一方 exact retry |
| receipt 被篡改 | ref/object 与 receipt 不一致 | fail closed |
| accepted ref 已推进 | 旧 base 不再匹配 | 不创建/接受 candidate |

## 4. Artifact lifecycle 与 GC owner

M2.2 只创建 candidate ref 与派生 receipt，不在尚未观察 SQLite terminal truth 时自行删除。后续 GC
必须由持有同一 storage-root write lease、并能读取 M2.1/M2.3 durable truth 的 owner执行，并区分：

1. 已由 SQLite successor 接受且已提升为 accepted ref 的 candidate；
2. 已提交 terminal no-effect 的 operation；
3. 明确 abandoned 且超过审计保留期的 operation；
4. orphan ref 无 receipt；
5. receipt 无对应 T1 或其身份与 RuntimeEvent 不一致。

任何无法从 immutable RuntimeEvents、accepted head 与 Git ref 联合证明的对象都只允许保留或
quarantine，不允许猜测删除。GC 的保留期、配额和审计记录属于独立 lifecycle PR；在其落地前，
candidate artifact 可以增长，但不得被本 authority 静默回收。

## 5. 平台能力矩阵

| 平台 | 当前承诺 |
|---|---|
| Linux | 短生命周期 helper、ref CAS、process-kill/reopen、receipt fsync/rename |
| macOS | 与 Linux 相同的 process-crash 收敛；不声称断电永久存储保证 |
| Windows | helper/ref CAS 与 process-kill/reopen；目录 fsync 为平台 no-op，不声称断电收敛 |

三平台由同一 Gitoxide helper workflow 执行 Rust contract、Runtime Host contract 和真实子进程 crash
用例。CI 通过只证明已列出的状态，不替代未实现的 discard/GC 与 M2.4 组合证明。

## 6. 不属于本切片

- 不提交 T2、workspace successor 或 canonical head；
- 不推进 `refs/maka/accepted`；
- 不执行 Write/Edit；
- 不创建 Desktop/CLI mode；
- 不处理 projection rotation/quarantine；
- 不声称 M3 continuation 已可使用。

M2.4 必须消费本 owner 的 opaque proof，并在 M2.1 SQLite transaction 成功后才允许推进 Git accepted
projection。任何失败都禁止退回 attached checkout 或旧 Git CLI 路径。
