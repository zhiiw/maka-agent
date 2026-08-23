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

# Gitoxide managed inspection 产品组合 v1

状态：M1.3 integration Draft。前置数据面合并后从最新 `main` 重建最终 PR。

## 主要不变量

> `ManagedWorkspaceInspect` 的源码视图只能来自 exact accepted Git tree 的 fresh projection；依赖视图只能来自同一 accepted tree 中 `package.json`、`package-lock.json` 所确定的 attested npm environment lease。任何一步不可用时都必须在工具调用发布结果前失败，禁止回退 attached checkout、系统 Git、`PATH` Git 或 source checkout 的 `node_modules`。

Owner 划分：

- packaged release owner：Gitoxide helper 与 npm runtime artifact；
- Gitoxide admission/import owner：source HEAD 与 immutable managed tree；
- dependency authority：manifest/lockfile identity、publication receipt 与 active lease；
- filesystem worker：单次只读 `Read/Glob`；
- Runtime Host composition：工具可见性、操作路由、取消、drain 与最终清理。

## 调用顺序

```text
canonical source cwd
  -> Gitoxide admission（冻结 source HEAD/tree）
  -> fresh Maka-owned bare import
  -> exact tree read: package.json + package-lock.json
  -> dependency identity + attested npm lease
  -> fresh accepted-tree projection
  -> Read/Glob routed to projection or leased node_modules
  -> projection re-observation
  -> bounded provider result
  -> release lease + remove ephemeral import/projection
```

`node_modules` 路由发生在完整 canonical path 校验之后。含空段、`.`、`..`、反斜杠、盘符或绝对路径的输入在任何 Git/npm 副作用前拒绝；Windows 的 `NODE_MODULES` 等大小写别名同样进入 dependency lease，不能落回 projection。

## 原子边界、失败与回滚

本切片不声称跨 Git/npm/filesystem 的单一事务，也不写 managed mutation T1。每次调用使用 fresh 随机 import/projection root；只有 dependency authority receipt 是可复用 durable artifact。

| 状态 | 处理 |
| --- | --- |
| helper/npm/worker 缺失 | 工具不进入 Host tool surface；普通 Host 功能继续可用 |
| source HEAD 在 admission/import 间变化 | import 前 fail closed |
| package manifest/lockfile 缺失或不合法 | 不启动 read worker，不回退 source bytes |
| provisioning/worker 取消 | signal 贯穿 helper、npm authority 与 worker |
| projection drift | 丢弃结果；不向 provider 发布 |
| 进程崩溃 | 不自动 replay；下一次显式调用使用 fresh root，旧 staging 等待后续 GC |

工具的 recovery mode 固定为 `never_auto_retry`。这是有意的产品边界：M1.3 证明可用的隔离读取，不冒充 M2 尚未完成的 durable Write/Edit 或 crash replay。

## 权限与产品入口

- 工具类别为 `custom_tool`，因此不会进入默认只读 Plan Mode；
- 工具可能联网下载依赖并写最多由 dependency authority 限制的 cache；
- 只有 Electron packaged Runtime Host 同时解析到严格 Gitoxide/npm manifest 和 sandboxed filesystem worker 时才暴露工具；
- CLI、开发态 Electron、缺少资源或完整性校验失败时都不会发现系统 Git 或静默降级。

外层已签名应用包是 v1 release trust root；本合同不抵抗能够改写整个已安装应用及其 manifest 的同用户恶意进程。

## 平台矩阵

Linux、macOS、Windows 使用相同 helper 协议、tree read、dependency identity 与路由规则。三平台 Gitoxide CI 执行真实 helper 的产品组合测试。Windows sandbox 目前只承诺 `Read/Glob`；本工具 v1 不暴露 Grep。

## 后续 M2

数据面和本产品入口稳定后：

1. 从最新 `main` 刷新 M2.1 accepted-head SQLite authority；
2. 从最新 `main` 刷新 M2.3 durable reservation 与 Runtime settlement；
3. 再用 Gitoxide successor/ref CAS 重建 M2.2 candidate owner；
4. 最后重建 M2.4 Write/Edit consumer。M2.4 不得恢复 Git CLI worktree rotation，也不得把 M1.3 的 ephemeral staging 当 canonical truth。
