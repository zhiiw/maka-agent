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

# Gitoxide accepted-tree file read 数据面 v1

状态：M1.3 product composition 前置 Draft。

## 主要不变量

> dependency manifest 与 lockfile 必须直接读取自 owner-bound managed repository 的 exact accepted commit/tree；不得从可变 projection、attached checkout 或 caller 路径读取后再冒充 immutable 输入。

## Owner 与边界

- Gitoxide managed-repository capability 冻结 repository path、accepted ref、commit 和 tree；
- caller 只能提交 canonical UTF-8 `/` path；不能提交 commit、tree 或 repository path；
- short-lived helper 从 exact commit tree 查找 regular blob，拒绝 tree、symlink、缺失路径、非 UTF-8 和超过 8 MiB 的文件；
- response 同时返回 commit、tree、blob OID、path、content 与 byte count；Runtime Host 对完整 envelope 严格校验，并再次与 capability identity 比较。

该操作只读 Git object database，不物化文件，不写 durable state，也没有 T1。失败时 fail closed；没有 projection fallback。

## 为什么不是“物化后 read + 再观察”

projection 是执行视图，不是 accepted truth。即使读取前后各做一次 drift observation，外部写入仍能发生在最后一次观察后，或者 manifest/lockfile 两次读取之间。直接从 immutable tree 读取把线性化点放回 Git object identity，也让 dependency environment identity 真正绑定 accepted source bytes。

## 平台与资源上限

Linux、macOS、Windows 使用同一 helper 协议与 8 MiB/file 上限。helper stdout owner 同步提供有限上界；超大、非 UTF-8 或非普通 blob 全部拒绝。三平台真实 Rust helper test 由 Gitoxide workflow 执行。

## 后续

M1.3 composition 只允许用本 capability 读取 `package.json` 与 `package-lock.json`，随后计算 dependency environment identity。M2.2/M2.4 仍等待 product composition 完成后从最新 main 重建。
