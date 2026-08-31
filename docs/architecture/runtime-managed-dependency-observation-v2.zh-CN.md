---
document_status: implementation-contract
status: draft-stacked-foundation
date: 2026-08-31
milestone: M5.4a
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

# Managed dependency observation v2

## 主要不变量

> dependency-aware `ManagedNodeTest` 在 T1 前必须冻结一种且仅一种依赖输入：显式 `none`，或者由
> snapshot authority 签发的 exact `environmentId + contentTreeSha256 + Node ABI/platform`；T1 后禁止
> 接受路径、自报 digest 或回退 attached checkout 的 `node_modules`。

本切片只定义 durable observation protocol 与 Runtime admission 的匹配规则，不签发 lease，也不把依赖路径交给
Runtime。snapshot lease 的签发仍由 `ManagedDependencySnapshotAuthority` 拥有；后续 Host consumer 只能把 opaque
lease 中的 identity 转换为这里的 durable dependency record。

## Owner 与原子边界

- Host admission owner 在 T1 前选择 `none` 或持有一个有效 snapshot lease。
- Runtime 只接受与工具 `managed_observation_v2` profile 完整匹配的 v2 dispatch。
- RuntimeEvent decoder 对 outer protocol、accepted Git identity、toolchain、dependency 和 files 执行 exact-shape
  校验；SQLite 仍只原子提交完整 T1 event，不新增第二套 dependency projection。

```text
accepted tree observation
  + verified toolchain identity
  + (explicit none | opaque dependency lease identity)
  -> exact managed_observation_v2 dispatch
  -> SQLite T1 commit
  -> later sandbox execution
```

## 失败与回滚

| 状态 | 处理 |
| --- | --- |
| dependency identity 缺失、畸形或平台不匹配 | T1 前拒绝，不执行测试 |
| tool profile 与 dispatch protocol/digest 不匹配 | Runtime T1 boundary fail closed |
| v2 dispatch 夹带 dependency path 或未知字段 | decoder 拒绝 |
| T1 commit 失败 | dispose admission/lease，不执行测试 |
| T1 已提交后 owner/worker 不确定 | 保持 durable evidence，禁止 generic fallback |

## 平台矩阵

Linux、macOS 与 Windows 使用同一 platform-independent durable shape。`platform` 只允许 `linux`、`darwin`、
`win32`，`arch` v2 只允许当前发布目标 `x64`、`arm64`。本切片不声称三个 sandbox 已经消费该 lease；实际只读
mount/junction/symlink 与 process-crash 证据属于下一切片。
