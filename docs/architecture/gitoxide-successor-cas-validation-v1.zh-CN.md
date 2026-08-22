# Gitoxide successor CAS validation v1

状态：验证切片，堆叠在 `Gitoxide repository admission v1` 之后；尚无
Desktop、CLI、Runtime Host 或 M2 Write/Edit 生产消费者，只能保持 Draft。

## 1. 主要不变量

本切片只验证一个主要不变量：

> 给定一个 Maka-owned SHA-1 repository、精确的 base commit、`refs/maka/*`
> accepted ref、单个路径和 UTF-8 after-content，Gitoxide broker 只能从该 base
> 构造确定的 blob/tree/commit，并且只有当 accepted ref 仍精确等于 base 时，才可通过
> ref compare-and-swap 发布 successor。

本切片不接入 checkout、linked worktree、projection rotation、SQLite、T1/T2、Desktop/CLI
或 Write/Edit 恢复。它验证 Gitoxide 是否足以承担 M2 中“immutable candidate + accepted-ref
CAS”这一窄能力，不宣称替代完整 Git CLI 生命周期。

## 2. Owner 与权限边界

| 项目 | v1 约束 |
| --- | --- |
| owner | `maka-gitoxide-broker` 单次进程请求 |
| 请求 | 最大 64 KiB strict JSON `create_successor` |
| repository | 必须通过 isolated/strict-config handle 打开的 SHA-1 repository |
| base | caller 提供完整 SHA-1 commit OID；broker 重新读取 commit/tree |
| ref | 只允许 `refs/maka/*`；其他 namespace 在写对象前拒绝 |
| content | canonical `/` 分隔相对路径 + UTF-8 content；拒绝空段、`.`、`..`、反斜杠和 `.git`；现有 executable blob 保留 `100755`，普通/新文件使用 `100644` |
| 非普通路径 | symlink、tree、submodule 目标 fail closed |
| publication capability | 仅 broker 内部持有；caller 不能选择非 CAS 的写入方式 |

## 3. 原子性边界

对象数据库允许在 publication 之前写入不可达对象；真正的线性化点只有 accepted ref 的更新：

```text
read exact accepted ref == expected base
  -> write blob/tree/commit (尚不可达)
  -> acquire ref lock
  -> MustExistAndMatch(expected base)
  -> publish accepted ref
```

ref 更新使用 Gitoxide 的 `PreviousValue::MustExistAndMatch`。这同时拒绝 ref 被推进、删除或替换，
不能退化为“ref 不存在时重新创建”。

## 4. 失败状态与回滚

| 失败点 | durable/visible 状态 | 处理 |
| --- | --- | --- |
| base 在初次读取时已不匹配 | ref 不变；不写 candidate 对象 | exit 3 + `base_commit_mismatch` |
| blob/tree/commit 构造失败 | ref 不变；可能留下部分不可达对象 | exit 1；后续由 repository GC 回收 |
| ref lock 获取失败 | ref 不变；candidate 对象不可达 | exit 1 + `successor_publish_failed` |
| 初次检查后 ref 发生竞争变化 | strict CAS 失败，ref 保留竞争者值 | exit 1；禁止 fallback/覆盖 |
| publication 成功后响应丢失 | ref 已是确定 successor | 本切片尚未提供 durable operation receipt；留给后续 owner 切片 |

这里没有跨 Git/SQLite 事务，也没有 rollback accepted ref 的接口。未来 M2 owner 必须在 T1 前确定
durable mode，并用 operation identity/receipt 解决“CAS 成功、响应丢失”；不能因为本验证能写 ref 就
直接接入生产恢复。

## 5. 验证证据

专用测试使用系统 Git **仅创建和独立读取 fixture**；broker 启动后清空 `PATH` 并注入恶意
`GIT_CONFIG_*`，因此 broker 不能调用系统 Git，也不能继承用户 Git 配置。

当前验证：

- SHA-1 repository admission 返回 exact HEAD/tree；
- SHA-256 repository stable reject；
- 从 exact base 发布 nested-path successor；
- target ref 已推进时拒绝并保持竞争者 ref；
- ref lock 被占用时不发布 candidate；
- 非 canonical path 在对象写入和 publication 前拒绝；
- 修改 executable blob 时保持 `100755`；
- Git CLI 独立验证 successor parent、tree、blob 和 exact bytes。

三平台复用 `.github/workflows/gitoxide-repository-admission.yml` 的同一 locked Cargo test suite。
普通 `npm test` 和最终用户运行不安装 Rust；只有 broker 源码验证/构建 lane 需要固定 Rust 工具链。

Windows x64 本地未专门 strip 的 release broker 为 8,090,624 bytes（约 7.72 MiB），相比只读
admission probe 增加 252,928 bytes（约 0.24 MiB）。locked Cargo closure 共 138 个 package；
未发现 GPL/AGPL-only dependency。`r-efi` 的复合许可包含 MIT/Apache-2.0 可选项，不要求选择
LGPL。该审计只是验证阶段证据，真正进入发行包前仍需生成并校验完整第三方 notices。

## 6. 平台能力矩阵

| 平台 | 本切片持续验证 | 未承诺 |
| --- | --- | --- |
| Linux | exact successor、mode、stale-base/ref-lock fail closed | packaging、process sandbox、power-loss recovery |
| macOS | 同 Linux | signing/notarization、`F_FULLFSYNC`、production crash recovery |
| Windows | 同 Linux | Authenticode、job owner、完整 Host/worker crash recovery |

SHA-256 repository 继续默认不可用。协议保留 object-format 字段，但未来只有在 Gitoxide 的对应
对象写入/ref CAS 能力经过同等级测试后，才可显式增加新的 capability；禁止静默降级到系统 Git。

## 7. 下一步

下一验证切片应只选择一个不变量：从 accepted commit 物化**全新的空 projection**，不使用 linked
worktree registration，也不复用旧 checkout。publication-response-loss receipt、SQLite accepted
truth 和 Write/Edit production composition 仍分别属于后续 owner，不能并入本切片。
