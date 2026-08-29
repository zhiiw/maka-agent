# Managed Workspace Source Relocation v1

## 主要不变量

managed workspace 的 durable identity 由 Host-owned Session identity（以及显式 epoch seed）决定，不由 source checkout 的绝对路径决定。把同一 exact source commit/tree 移到另一目录后，系统应重新 admission 并打开原 repository/workspace/epoch。

## Owner 与验证边界

- Session owner 派生 repository/workspace identity；调用者不能提交裸 identity。
- Gitoxide admission 在新路径重验 repository、HEAD commit/tree、policy 与 helper artifact。
- SQLite epoch 中冻结的 source commit/tree 必须与新路径 observation 精确一致。
- managed bare repository 和 accepted head 从原 storage root 重开；source path 只是一项可替换 observation。

如果新路径内容不同、object format/policy 不匹配或 accepted repository 不可重验，relocation fail closed，不创建新 epoch也不静默 fallback。

## 范围与平台

v1 覆盖同一机器、同一 storage root 内的 source checkout relocation，Linux/macOS/Windows 语义相同。跨 storage root/跨设备迁移仍需显式 artifact copy + root-binding transition，不在本合同内。

