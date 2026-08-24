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

# Gitoxide fresh projection 数据面 v1

状态：API-only stacked Draft。该切片不做 canonical-path rotation、quarantine、Desktop/CLI 接线或 Write/Edit 恢复。

## 主要不变量

只有 owner-bound managed-repository capability 可以把其绑定的 exact accepted commit 物化到此前不存在的 staging 目录；只有物化成功后签发的 projection capability 可以重新观察该路径。clean 只表示 projection 中的全部路径、类型、内容和 POSIX executable bit 与 immutable Git tree 完全一致。

## Owner 与原子性边界

- caller 只能选择 owner 管理下的 fresh destination；repository path、commit 与 tree 来自 capability，不能重新提交；
- Gitoxide helper 以 `create_dir` 获得 fresh-root 线性化点，文件使用 `create_new`，不写 `.git`，不创建 linked worktree；
- source import 已拒绝 symlink/submodule、非 UTF-8、大小写/NFC collision、`.git` 与 `.gitattributes`，projection 再次 fail closed 校验这些 entry；
- 每个普通文件有 64 MiB 上限，整棵 tree 有 2 GiB/200k 文件上限；
- observer 使用 bounded read 和 Git blob identity，拒绝缺失、额外、类型变化、内容变化与 POSIX executable-mode drift；打开普通文件时使用 no-follow 标志；
- helper 在响应丢失后遇到已存在目录，只在它仍精确等于 accepted tree 时返回相同 materialization response；partial/drifted 目录不会被静默覆盖。

## 失败状态与回滚

- materialization 中进程退出：staging 可能部分存在，但没有 `.git` 能力、没有 accepted-head 变化；composition owner 必须隔离或删除其私有 staging 后重试；
- destination 已存在且不精确：`projection_destination_not_fresh`；helper 不删除任何用户路径；
- projection drift：返回结构化 `projection_drifted` 与首个确定性 reason/path；不修改 projection；
- power-loss durability 不在 v1 合同内；v1 只证明正常完成和 process-crash 后的 fail-closed/retry 边界。

## 平台能力矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | exact materialization/observation；POSIX executable mode；`O_NOFOLLOW` |
| macOS | 同 Linux；普通 fsync 不提升为 power-loss 承诺 |
| Windows | exact content/path/type；Git executable bit 不映射为 NTFS ACL；reparse-point 路径不作为普通文件读取 |

## 后续消费

M1.3 product composition 将拥有 storage-root、staging 命名、partial staging cleanup、canonical projection publication 与 lifecycle。M2.2/M2.4 只在这套 Gitoxide 数据面完成后重建，不再依赖 system/bundled Git CLI。
