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
milestone: M5.6
---

# Managed coding v2 full-loop crash proof v1

## 主要不变量

> 同一个 `managed-coding-v2` task 中，`Edit -> ManagedNodeRun -> ManagedNodeTest` 必须共享同一个 accepted-world
> 因果链。Host 在 command durable outcome 之后退出时，新 Run 只能采用已提交的 Edit successor 与 command
> result；禁止重放二者，后续 test 必须从同一 accepted successor 与 dependency snapshot 继续。

## Owner 与线性化边界

- Gitoxide mutation owner 把 Edit 的 pure transform 固化为 candidate；
- SQLite acceptance transaction 同时提交 Edit T2、successor fact 与 accepted head；
- Node command admission 在自己的 T1 前冻结新的 accepted head、entry、argv、toolchain 与 dependency identity；
- command T2 是 command observation 的唯一恢复事实；
- continuation owner 在新 Run 中采用旧 Run 的 durable result，再允许 Node test 获得下一次 admission；
- provider 只选择下一步工具，不拥有 accepted head、dependency path 或 durable result 的改写权。

```text
accepted A
  -> Edit candidate B
  -> SQLite accepts B
  -> Node command(B + dependency snapshot)
  -> durable command T2
  -> kill Host before provider response
  -> continuation adopts command T2
  -> Node test(B + same dependency snapshot)
  -> completed
```

## 失败、回滚与 park

| 边界 | 处理 |
| --- | --- |
| Edit 在 T1 前失败 | 不产生 reservation/candidate；仍停留在 A |
| Edit T1 后无法证明 candidate | park，不运行 command |
| command T1 前 admission 失败 | B 保持 accepted；command 不执行 |
| command T2 后 Host 退出 | 新 Run 采用 T2；command 不重跑 |
| continuation 与 accepted head 不一致 | fail closed / park；不得从 attached checkout 测试 |
| test observation 失败 | 作为有界 durable observation 返回，不撤销 B |

## Production-shaped evidence

测试启动真实 packaged Runtime Host、真实 Gitoxide helper、真实 sandboxed Node helper 与 SQLite stores。fixture 先通过
`Edit` 把 `41` 改为 `42`，然后 command 从 accepted source 与 immutable dependency snapshot 计算 `142`。在 provider
收到 command result、尚未提交下一条模型响应时强杀 Host；重启后 continuation 采用同一 result，随后 test 再次从
accepted successor 验证 `142`。最终 ledger 中 Edit、ManagedNodeRun 与 ManagedNodeTest 都恰好各有一个 call 与一个
response。

## 平台矩阵

- Linux/macOS：enforcing sandbox 可用时执行完整 kill/restart 链；
- Windows：在 Windows sandbox 发布合同完成前，`managed-coding-v2` 明确 unavailable，测试证明不会降级；
- 三个平台都不承诺硬件断电恢复，也不允许 attached checkout fallback。

## 非目标

- 不安装依赖或引入 package manager；
- 不把 fenced Bash 伪装成 replay-safe observation；ShellRun 的 external-effect evidence 由独立测试证明；
- 不在本切片实现 Publish、Undo 或 source rebaseline；
- 不为尚未发布的旧 managed profile 保留兼容分支。
