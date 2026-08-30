---
document_status: implementation-contract
status: draft-stacked-foundation
date: 2026-08-31
milestone: M5.3
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

# Managed dependency snapshot authority v1

## 主要不变量

> 一个显式选择、已经存在的 npm `node_modules`，只有在 source observation、Maka-owned copy 和 durable
> receipt 的内容 identity 全部一致时才能获得 read-only lease；导入过程不得启动 package manager、访问网络、
> 读取 `PATH` 或把 source inode 直接发布为 artifact。

Owner 是 `ManagedDependencySnapshotAuthority`。底层 artifact publication、receipt、lease、跨进程 storage-root
lock 与 GC 继续由 `ManagedDependencyEnvironmentAuthority` 唯一拥有；snapshot adapter 只拥有 source observation
和一次 acquisition 的 source-to-staging copy。调用者拿不到 producer capability、canonical artifact path 或 receipt
writer。`@maka/storage` 只导出 `managed-dependency-snapshot-authority` 这一条窄入口；generic producer factory、
receipt authority 和 artifact publication 实现不属于 package exports。

这一步刻意不引入 bundled npm，也不承诺安装缺失依赖。source 中没有可接受的 `node_modules` 时，依赖能力明确
unavailable；后续若增加 installer，必须作为另一种受权 producer 单独证明。

## 原子性与收敛边界

```text
explicit node_modules source
  -> reject symlink/junction root
  -> hash complete source tree
  -> bind logical identity from package.json/package-lock.json + Node ABI/platform
  -> copy into random producer staging
  -> hash copied tree and require exact source digest
  -> deep-copy into fresh authority-owned inodes
  -> durable seal + artifact rename
  -> SQLite receipt commit
  -> reopen and revalidate
  -> lease
```

同一 manifest/lockfile/Node identity 只允许一种已发布内容。后来的 source tree 若字节不同，owner fail closed，不
静默替换既有 artifact。source 在 observation 与 copy 之间漂移时，copied digest 不一致，publication 在 receipt 前
失败。

文件系统与 SQLite 不组成伪事务：artifact 无 receipt 时由重启清理并重新导入；receipt 已提交时重启重验并复用；
两者存在但内容不一致时拒绝。真实 child-process 测试覆盖 artifact publish 后退出及 receipt commit 后退出。

## 失败与回滚

| 状态 | 处理 |
| --- | --- |
| source 缺失、root alias/reparse 或内容不受支持 | receipt 前拒绝，无 lease |
| source observation 后漂移 | copied digest 不匹配，删除随机 staging |
| 同一 logical identity 出现不同依赖字节 | 释放临时 lease 并 fail closed，既有 artifact 不变 |
| artifact rename 后进程退出 | 下次 owner 删除 orphan artifact，重新导入 |
| receipt commit 后进程退出 | 下次 owner重验并复用，不重写 source |
| active lease 存在时 close | close 拒绝，owner 保持 open |

## 平台矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | 进程崩溃收敛；仅在文件系统兑现 fsync 时具备现有 authority 的断电顺序 |
| macOS | 进程崩溃收敛；不声明 `F_FULLFSYNC`/断电保证 |
| Windows | 进程崩溃收敛；拒绝 source root reparse、artifact reparse 与 ADS；不声明断电保证 |

本切片不声称 polling/soft cache quota 是硬磁盘上限。source 是用户显式授权的本地输入；未来 installer 或不可信
archive 必须由 OS/filesystem quota 或受控 streaming writer 提供独立硬边界。

## 后续 consumer

下一切片把 lease 作为 `ManagedNodeTest` admission 的 opaque dependency capability：sandbox 只读 accepted input
与 leased dependency root，只写 disposable scratch。T1 必须同时绑定 accepted head、dependency environment id、
content tree digest、Node ABI/platform 和 sandbox profile；缺少 lease 时禁止回退到 checkout 的 `node_modules`。
