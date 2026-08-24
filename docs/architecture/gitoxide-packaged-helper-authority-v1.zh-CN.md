---
title: Gitoxide packaged helper authority v1
status: Draft
milestone: M1.3
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

# Gitoxide packaged helper authority v1

## 1. 主要不变量

本切片只证明一件事：

> 只有当前 Maka 发布流程构建、清单绑定并随应用资源一起交付的 exact Gitoxide helper，才能被转换成 Runtime Host 内部的调用 capability；普通 caller 不能用裸路径、PATH 发现或自报摘要获得执行权。

它不负责 source import、candidate、projection 或 Desktop managed task。这些能力消费本切片签发的 opaque capability，不能重新接受 executable path。

## 2. Owner 与权限边界

- release build owner：使用锁定的 `native/gitoxide-helper/Cargo.lock` 构建 release binary；
- preparation owner：复制到 fresh `.generated/gitoxide-helper`，计算 bytes/SHA-256，并写 `maka_gitoxide_helper_release_v1`；
- legal owner：从同一个 Cargo.lock graph 生成随包交付的 crate license/notice；
- packaged-resource owner：Electron 只携带 helper、manifest 和 notice；
- Runtime Host release owner：从平台应用已经授予的 `resourcesRoot` 读取严格 manifest，签发 release claim；
- invocation owner：每次调用前重新验证 canonical path、file identity、bytes 和 digest。

manifest 是发布资源的完整性声明，不是独立密码学签名。v1 的外层 trust root 是操作系统认可的应用发布/签名边界；同一用户权限下能同时改写已安装应用和 manifest 的攻击者不在本切片单独抵抗的威胁模型内。后续产品接线只能传递 Desktop 已持有的 packaged-resource authority，不能把公开 CLI 路径参数当成 authority。

## 3. 原子性与失败状态

preparation 先写 fresh helper 目录，再用临时 manifest rename 发布声明。生成失败时整个 `.generated` 输出不是发布输入，打包必须停止。

Runtime admission 只有两种结果：

- exact manifest 与 artifact 匹配：签发 owner-bound invocation capability；
- manifest、平台、路径、类型、大小或摘要任一不匹配：fail closed，不发现 system Git，也不尝试旧 bundled Git。

它没有 T1，也不写 durable state；rollback 是丢弃 `.generated/gitoxide-helper` 并重新构建。

## 4. 平台能力矩阵

| 平台 | 构建/资源 | 运行时校验 | 当前证据 |
| --- | --- | --- | --- |
| Linux x64 | CI release helper | non-symlink regular file、identity、bytes、SHA-256 | Gitoxide workflow |
| macOS arm64 | release helper 随 app 签名 | 同上；外层 trust root 为已签名 app | Gitoxide workflow；正式 notarized artifact 仍由 release lane 验证 |
| Windows x64 | release helper 随安装包 | 拒绝 symlink/junction path，校验 identity、bytes、SHA-256 | Gitoxide workflow |

开发态不会从 PATH、system Git 或任意 `resourcesPath` 自动启用 managed Git。没有经过明确测试 authority 注入时，Gitoxide managed profile 必须报告 unavailable。

## 5. 许可证与包体

Gitoxide helper 是单个短生命周期 Rust binary，不携带 Rust 工具链。Cargo notices 从 exact lock graph 在发布时生成并放入 `licenses/gitoxide-helper/THIRD_PARTY_NOTICES.txt`。普通 TypeScript 开发和非 Gitoxide 测试不需要安装 Rust；只有修改 helper、运行其三平台 CI 或构建正式安装包时需要锁定 Rust toolchain。

## 6. 后续产品接线

下一切片必须由同一个 Runtime Host composition 生命周期持有：

1. packaged-resource authority；
2. Gitoxide invocation/admission/import/projection capability；
3. bundled npm capability 与 dependency storage authority；
4. 专用 managed task consumer。

Host handshake 必须声明 exact managed profile。CLI 启动的无 packaged-resource Host 不能被 Desktop 静默复用为支持该 profile 的 Host；不匹配只能显式拒绝或安全替换，禁止 fallback。
