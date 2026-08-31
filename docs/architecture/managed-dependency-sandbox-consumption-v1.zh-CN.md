---
document_status: implementation-contract
status: draft-stacked-production
date: 2026-08-31
milestone: M5.4
---
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

# Managed dependency sandbox consumption v1

## 主要不变量

> `ManagedNodeTest` 与 `ManagedNodeRun` 在 T1 前只能选择 `none` 或一个 owner-issued immutable dependency snapshot；选择 snapshot
> 后，T1 必须绑定其 environment、content tree、Node ABI/platform identity，sandbox 只能只读该 snapshot，且禁止
> 回退到 attached checkout、`PATH`、package manager 或网络。

Owner 分为三层：

- `ManagedDependencySnapshotAuthority` 唯一拥有 artifact publication、receipt 与 lease；
- `ManagedNodeDependencyOwnerInternal` 只把 accepted tree 的 `package.json`/`package-lock.json` 与 source 中
  已存在的 npm `node_modules` 组合成 snapshot acquisition；
- `ManagedCommandSandboxOwnerInternal` 持有同一个 consumer owner token，只有它能从模块私有 `WeakMap` 解析
  dependency root 与 runtime identity、验证它们匹配当前 toolchain，并把 root 加入 enforcing sandbox。

Runtime、tool args 和 durable RuntimeEvent 都看不到 dependency path。结构伪造的 lease、其他 owner 的 lease、已
release 的 lease都会在进程启动前被拒绝。

## 原子性边界

```text
accepted Git tree materialized
  -> bounded read accepted package.json + package-lock.json
  -> observe/copy/hash existing source node_modules
  -> durable artifact receipt
  -> opaque lease
  -> T1(node_test_v2/node_command_v2 + exact dependency identity)
  -> sandbox read-only accepted tree + read-only dependency snapshot
  -> exact durable observation outcome
  -> release lease + delete disposable execution roots
```

没有 `node_modules` 时在 T1 前明确选择 `dependency.kind = none`。存在 `node_modules` 但 metadata 缺失、漂移或
snapshot identity 与 toolchain Node identity 不一致时，T1 前 fail closed；不尝试 npm install，也不静默运行 attached
依赖。

## 失败与回滚

| 状态 | 处理 |
| --- | --- |
| snapshot receipt 前失败 | 删除 staging；不写 T1 |
| snapshot receipt 后、T1 前失败 | release lease；artifact 进入普通 cache/GC 生命周期 |
| T1 后 helper/Host 失败 | 保留 immutable T1/outcome evidence；恢复只重放 observation protocol，不重新安装依赖 |
| dependency lease 被伪造、错 owner 或已 release | helper spawn 前拒绝 |
| accepted metadata 与 attached source 漂移 | accepted metadata 仍是 identity owner；source 只提供被完整 hash/copy 的依赖字节 |

## 平台矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | namespace sandbox 只读 accepted/dependency roots；network/child process 禁止 |
| macOS | Seatbelt 只读 accepted/dependency roots；network/child process 禁止 |
| Windows | AppContainer 对 dependency root 使用递归 read grant；卷根仅 exact metadata anchor；禁止 write/network/descendant |

三平台都不承诺安装缺失依赖，不执行 lifecycle scripts。真实 packaged Host kill/reopen gate 使用一个 ESM 测试从
leased dependency snapshot 导入 package，并证明已完成结果不会在恢复时重跑。
