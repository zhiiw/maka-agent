# Desktop isolated Restore v1

## 1. 能力边界

Desktop Review 面板可以把当前 managed task 的 exact accepted tree 恢复到 Maka-owned 隔离目录。v1 不接受调用方
指定 destination path，也不修改 source checkout。

```text
durable accepted commit/tree
  -> Gitoxide bounded materialization
  -> <storageRoot>/gitoxide-managed-restores/<epoch>/<restoreId>/workspace
```

## 2. Owner 与权限

- renderer 只签发稳定 `restoreId`，不能提交 repository path、commit、tree 或 destination；
- Desktop main 只允许 `managed-coding-v1` session 进入 restore IPC；
- Runtime Host 从 session header 重新打开 managed session owner；
- restore owner 从 SQLite accepted head/version 读取 exact commit/tree；
- Gitoxide helper 只向 owner 选择的 staging path 物化 accepted tree；
- source checkout 与 attached workspace 不获得写权限，也不参与恢复结果。

## 3. 原子性与收敛

文件系统无法与 SQLite/Git ref 组成跨介质事务。v1 使用 owner-owned intent/staging/receipt 协议：

1. 在 restore root 写 durable intent；
2. 向 fresh staging directory 物化并验证 accepted tree；
3. rename staging 为固定 workspace path；
4. 写 receipt；
5. 删除 intent。

同一个 `restoreId` 重试时，残留 staging/workspace 先整体移动到 owner-owned orphan root，再从同一 accepted tree
重建。因此 response 丢失或进程退出不会覆盖用户目录，也不会重新执行 Write/Edit。

## 4. 失败状态与回滚

- 非 managed session、helper 不可用、accepted identity 不可证明：fail closed；
- restore path 不是 owner 创建的真实目录或出现 symlink/reparse tamper：fail closed；
- helper materialization 与 accepted tree 不一致：保留 intent/staging 供诊断，禁止发布 workspace；
- 取消或崩溃：下次相同 ID 通过 orphan rotation 收敛；
- 回滚只处理 Maka-owned restore artifacts，不删除或改写 source checkout。

## 5. 平台矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | fresh-directory materialization、rename publication、orphan retry |
| macOS | 同 Linux；所有 owner 路径先 canonicalize |
| Windows | 同一身份协议；文件占用导致 rename 失败时保留可重试 residue，不静默删除 |

现有 helper 与 owner 测试证明 accepted-tree materialization；Desktop 协议/IPC 测试证明普通 session 无法进入。
packaged Desktop 的真实 kill/restart 证据仍是发布门槛。v1 不承诺硬件断电持久性。

## 6. 非目标

- 不恢复到用户指定目录；
- 不 Apply 到 source checkout；
- 不选择历史 workspace version；
- 不实现 Undo、timeline 或 restore artifact GC。
