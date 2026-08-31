# Managed Toolchain Artifact Authority v1

## 主要不变量

M5 命令不能从 `PATH`、调用者传入路径或相邻自签 manifest 取得执行权限。只有 release/dev owner 签发、并由 invocation owner 绑定的 opaque capability，才能让后续 command owner 使用 toolchain。

v1 capability 同时绑定：

- Node 24 的精确版本声明；
- platform / arch；
- executable 的 canonical path、大小和 SHA-256；
- 固定 command entrypoint 的 canonical path、大小和 SHA-256；
- profile version；
- 允许的 effect class。

当前只允许 `hermetic_observation_v2` 与 `workspace_transform_v1`。`external_effect_v1` 不在 capability 中，因此后续代码不能通过同一入口静默获得网络、凭据或远端副作用权限。

## Owner 与权限边界

- release owner 决定发行物声明；本模块不把相邻 manifest 自身当成 trust root。
- admission owner 验证 platform/arch 与两个文件 artifact，签发不可伪造 capability。
- invocation owner 每次使用前重新验证 executable 与 entrypoint 的 bytes、inode/path identity 和 symlink/junction components。
- command owner 只能请求 capability 已允许的 effect class。

Node 版本声明的真实性来自 release/dev owner；本 authority 负责阻止声明与实际 artifact 在 admission 后漂移。M5 的 production composition 必须把该 owner 接到已经验证的 packaged/dev assembly，不能开放裸 claim API。

## 原子性、失败与回滚

本切片没有 durable publication。capability 只存在于进程内 WeakMap：

- admission 前失败：不签发 capability；
- admission 后 artifact 改变：下一次 invocation fail closed；
- owner token 不匹配或 effect class 未授权：拒绝执行；
- Host 退出：capability 自动失效。

因此不需要文件系统回滚。后续 command sandbox 必须在 T1 前取得并冻结此 capability/profile；T1 后禁止 fallback 到系统 Node 或 shell。

## 平台矩阵

Linux、macOS、Windows 都验证普通文件、路径组件、bytes 和 owner token。v1 只定义 artifact authority，不宣称三平台 command sandbox 已完成；无法证明 sandbox profile 的平台在 M5.2 中必须报告 unavailable。
