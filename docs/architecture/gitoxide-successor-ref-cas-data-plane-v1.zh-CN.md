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

# Gitoxide successor/ref CAS 数据面 v1

状态：API-only Draft。该切片不接 Desktop/CLI，不实现 projection，也不宣称 Write/Edit 已经恢复闭环。

## 主要不变量

一个 owner-bound managed-repository capability 只能从它绑定的 exact base commit 构造确定性的单路径 successor；`refs/maka/*` 只有在当前值仍等于 exact base 时才可通过 CAS 前进。调用者不能重新提交 repository path、base commit 或 target ref。

## Owner 与原子性边界

- source-import authority 在成功导入后签发 opaque managed-repository capability，内部绑定 Maka-owned bare repository、accepted ref、base commit 与 base tree；
- 短生命周期 Gitoxide helper 只接受 SHA-1 repository、canonical UTF-8 `/` 路径和不超过 64 MiB 的文本内容；SHA-256 仍在 admission 阶段 fail closed；
- helper 从 immutable base tree 写入 blob、tree 与确定性单父 commit；这些对象在 ref 发布前都不是 accepted truth；
- 唯一线性化点是 `PreviousValue::MustExistAndMatch(base)` 的 ref transaction；CAS 失败不会移动 accepted ref；
- 若响应丢失，而 ref 已等于本次请求确定性计算出的 successor，精确重试返回相同 response，不会再生成一代 successor；
- 成功结果签发下一代 capability，旧 capability 只可用于同一请求的精确重试，不能基于过期 base 发布另一项修改。

## 失败状态与回滚

- ref 已由其他 successor 前进：返回 `base_commit_mismatch`，不覆盖当前 ref；
- helper/config/object/path/content 不满足协议：fail closed，不调用 system Git，不从 `PATH` fallback；
- CAS 前进程退出：新对象可能成为不可达对象，accepted ref 不变，可由后续 GC 回收；
- CAS 后响应丢失：相同请求通过确定性 successor identity 收敛；
- SQLite accepted-head、candidate receipt、projection 与 quarantine 不属于本切片，分别由重建后的 M2.1、M2.2/M2.4 和后续 projection owner 承担。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | 短生命周期 helper、exact-base CAS、精确重试；由三平台 workflow 验证 |
| macOS | 同 Linux；不依赖系统 Git 作为生产数据面 |
| Windows | 同 Linux；路径协议统一使用 canonical `/`，反斜杠输入在 helper 前拒绝 |

这里不承诺对同一用户恶意替换 Maka 私有 storage root 的安全隔离；storage-root ownership 与进程级锁由产品 composition 切片负责。

## 后续依赖

1. Gitoxide fresh projection materialization/observation；
2. M1.3 product composition 消费 admission/import/candidate/projection capabilities；
3. 数据面完成后，从最新 `main` 重建 M2.2 candidate durable owner 与 M2.4 Write/Edit 生产闭环。
