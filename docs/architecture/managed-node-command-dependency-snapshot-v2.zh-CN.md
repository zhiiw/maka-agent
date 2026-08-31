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

---
document_status: implementation-contract
status: stacked-draft
date: 2026-08-31
milestone: M5.4
---

# Managed Node command dependency snapshot v2

## 主要不变量

> `ManagedNodeRun` 只能从同一 accepted Git tree 与一个 owner-issued immutable dependency snapshot 读取
> JavaScript；dependency identity 必须在 T1 前持久化，执行时禁止回退到 source checkout、`PATH`、网络或 package
> manager。

## Owner 与原子性边界

- `ManagedDependencySnapshotAuthority` 发布、验证并租用 dependency artifact；
- `ManagedNodeDependencyOwnerInternal` 只从 accepted `package.json` / `package-lock.json` 与 source 中已存在的
  `node_modules` 获取 snapshot；
- `ManagedNodeCommandAdmissionOwnerInternal` 在 T1 前冻结 accepted head、entry、argv、toolchain 与 dependency
  identity；
- `ManagedCommandSandboxOwnerInternal` 是唯一可把 opaque lease 解析为真实路径的 consumer，并把 accepted tree 与
  dependency tree 都作为只读 sandbox input；
- helper 只为 bare package specifier 重定向到 snapshot。相对/绝对 import 仍按 accepted tree 解析。

```text
accepted tree + source dependency observation
  -> immutable snapshot receipt + opaque lease
  -> materialize accepted input
  -> inspect exact entry
  -> T1(node_command_v2 + dependency identity)
  -> short-lived sandbox helper
  -> immutable command observation T2
  -> release lease + delete disposable roots
```

## 失败与恢复

| 状态 | 结果 |
| --- | --- |
| source 没有 `node_modules` | T1 明确绑定 `dependency.kind = none` |
| metadata、source tree 或 receipt 不一致 | T1 前 fail closed |
| lease 伪造、错 owner 或已释放 | helper spawn 前拒绝 |
| Host 在 observation T2 后退出 | continuation 采用 durable outcome，不重跑 command |
| Host 在 T1 后、T2 前退出 | hermetic observation 可按同一 accepted boundary 重建；不得借用 attached dependency |

## 平台能力

Linux、macOS、Windows 使用同一 dependency identity 与 helper protocol。各平台都要求 enforcing sandbox；若平台
不能只读授权 snapshot，整个 `managed-coding-v2` profile unavailable，禁止降级。该合同只承诺进程崩溃恢复，不
承诺硬件断电持久性。

## 非目标

- 不捆绑或下载 npm；
- 不运行 `npm install`、package scripts 或 lifecycle scripts；
- 不把 dependency snapshot 授予 `ManagedNodeTransform`；
- 不让 caller 看到 dependency path；
- 不为尚未发布的旧 observation v2 形状保留兼容分支。
