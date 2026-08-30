# Desktop immutable Publish v1

## 1. 能力边界

Desktop Review 面板可以把当前 managed task 的 exact accepted commit 发布为 Maka 内部不可变 ref：

```text
refs/maka/published/<publishId>
```

v1 只固定 accepted snapshot 的长期身份，不修改用户 source checkout、不创建用户分支、不执行 push，也不把
Publish 描述成 Apply。

## 2. Owner 与权限

- UI 只生成一个稳定、可重试的 `publishId`；
- Desktop main 只允许 `managed-coding-v1` session 进入该 IPC；
- Runtime Host coordinator 重新打开该 session 的 managed owner，不接受 repository path、commit 或 ref 作为 caller
  输入；
- Gitoxide managed publish owner 从 durable session identity 读取 accepted commit/tree，并拥有 ref CAS；
- provider、renderer 和 attached checkout 都不能指定要发布的 commit。

## 3. 原子性与收敛

原子性边界是 Git ref compare-and-swap：

```text
missing published ref -> exact accepted commit
```

- ref 缺失：创建并返回 `replayed=false`；
- ref 已精确指向同一 accepted commit：返回 `replayed=true`；
- ref 指向其他 commit、accepted identity 无法证明或 helper 不可用：fail closed；
- response 丢失：Desktop 使用同一 `publishId` 重试，不生成第二个 publication identity；
- 没有 checkout mutation，因此不需要回滚用户文件。

## 4. 失败状态

- 非 managed session：`managed_workspace_review_unavailable`；
- Host 未组合 Gitoxide helper：`managed_workspace_helper_unavailable`；
- session/accepted tree/ref identity 损坏：`managed_workspace_review_failed`；
- renderer 只展示经过 redaction 的一般错误，不把本地路径或 helper stderr 泄漏到 UI。

## 5. 平台矩阵

| 平台 | v1 承诺 |
| --- | --- |
| Linux | Gitoxide ref CAS、exact retry 和 fail-closed identity |
| macOS | 同 Linux；路径先 canonicalize |
| Windows | 同 Linux；不依赖删除或原地替换用户 checkout |

v1 的 helper/Host 定向测试证明 ref 合同与 IPC 权限；packaged Desktop 在真实进程终止后的重试证据仍是发布门槛。
v1 不承诺硬件断电持久性。

## 6. 后续关系

Apply 必须是新的 owner：它需要重新观察 source checkout、dirty state、branch/ref 和 drift，并发布 durable apply
receipt。不能因为 snapshot 已 Publish 就静默覆盖用户工作区。
