# Gitoxide source eligibility validation v1

状态：最后一个 Gitoxide 可行性验证切片；堆叠在 source import 之后，没有生产消费者，保持 Draft。

## 1. 主要不变量

本切片只验证：

> source eligibility owner 对调用方冻结的 exact SHA-1 HEAD 做一次只读、fail-closed observation。
> 只有请求路径是 repository worktree root、HEAD 未前进、index 与 worktree 无 tracked/staged/untracked
> 变化、且不存在受禁止的 Git indirection/runtime config 时才返回 clean。ignored 文件明确不参与 source
> baseline，因此 `node_modules` 等已忽略依赖不会阻止进入 managed mode。

该 observation 不是 durable admission，也不是跨文件原子 snapshot；真正接入时必须在 T1 前与 source
HEAD/tree 重新验证和 baseline import 组合，T1 后禁止 fallback。

## 2. Owner 与权限边界

| 项目 | v1 行为 |
| --- | --- |
| repository root | 对请求路径与 Gix workdir 分别 canonicalize 后比较；子目录不能获得 source capability |
| object format | 仅 SHA-1；SHA-256 保留协议扩展位但当前 fail closed |
| head identity | actual HEAD 必须等于 caller 冻结的 expected OID；不接受“最新 HEAD”替代 |
| clean policy | HEAD↔index 与 index↔worktree 均无变化；逐文件报告 untracked；ignored 明确排除 |
| submodule | v1 不执行 submodule status；source tree/import 阶段仍拒绝 gitlink entry |
| unsafe indirection | 拒绝 object alternates、replace refs、include/includeIf、partial clone/object-format extension、fsmonitor、promisor remote |
| external filters | Local/Worktree runtime config 在 status observation 中整体不可见；repository filter driver 不能获得进程执行能力 |
| mutation | 不写 index，不刷新 stat cache，不修改 worktree/ref/config；只返回 observation |

禁用 Local/Worktree config 会让依赖 `autocrlf` 或自定义 filter 才能呈现 clean 的 repository 保守失败。
这是有意的 v1 取舍：误拒绝可以显式 park，执行 repository-defined command 则会扩大安全边界。

## 3. 状态、失败与回滚

成功返回 `source_eligible`：

```text
state = clean
headCommitOid / headTreeOid
```

HEAD 变化或任一 staged/tracked/untracked path 返回 exit 3 + `source_ineligible`。repository root、对象库、
config/reference/status 不可安全读取，或发现 unsafe indirection 时返回稳定 broker error（exit 1）。所有路径
都无副作用，因此没有 rollback；上层不能把读取失败解释成 clean。

status observation 与后续 source import 之间仍存在时间窗口。生产 owner 必须把两者组织为：

```text
observe eligible exact HEAD
  -> import exact immutable HEAD/tree into fresh Maka-owned repository
  -> revalidate source identity if product policy requires
  -> T1/admission
```

source 在 observation 后产生的新未提交变化不会被导入 immutable HEAD，但产品可以选择在 T1 前再次
observation 并拒绝；不能在 T1 后偷偷切换 attached mode。

## 4. 验证矩阵

共享测试当前覆盖：

- clean source + ignored `node_modules`；
- tracked worktree modification；
- staged index addition；
- untracked path；
- stale expected HEAD；
- repository subdirectory；
- object alternates 与 replace refs；
- repository-defined clean filter 不被执行。

| 平台 | 语义承诺 | 明确限制 |
| --- | --- | --- |
| Linux | exact root/head，tracked/staged/untracked/ignored，config/filter fence | 当前没有 scan deadline/file-count budget |
| macOS | 同 Linux，canonical path 处理 `/var` 等 alias | 不承诺 APFS snapshot/power-loss |
| Windows | canonical root、case-insensitive root equality、相同 clean policy | 不把 ACL 当 Git mode；完整 Host crash 尚未接入 |

启用 Gix `status` feature 后 locked package 数从 138 增到 151。Windows x64 未专门 strip 的 release
broker 为 12,131,840 bytes（约 11.57 MiB），比 source-import probe 增加 3,866,112 bytes（约
3.69 MiB）。这说明 source status 是目前体积增长最大的单项，生产打包时值得单独 strip/LTO，并评估
是否把 eligibility 做成独立按需组件；无需因此绑定完整 Git CLI。

同一 Windows artifact 经 `llvm-strip --strip-all` 后为 8,770,560 bytes（约 8.36 MiB），说明约
3.21 MiB 是可在 release pipeline 去除的符号开销；正式包体预算应以签名后的三平台 strip 产物为准。

对 151 个 locked package 的 license metadata 复核未发现只能按 GPL/AGPL/LGPL 分发的依赖；所有
表达式都提供 MIT、Apache-2.0、BSD、ISC、Zlib、Unicode 或 public-domain 类可选路径。`r-efi` 的
SPDX 表达式包含 LGPL 作为 `OR` 选项，同时也明确提供 MIT/Apache-2.0，因此不会强制选择 LGPL。

## 5. 最终验证结论

Gitoxide 已经证明能覆盖 managed workspace correctness core 的最小数据面：

```text
source eligibility + exact SHA-1 HEAD
  -> isolated Maka baseline object database
  -> exact-base successor CAS
  -> fresh projection materialization
  -> exact projection drift observation
```

仍未证明、也不应伪装成已支持的能力：

- SHA-256 repository；
- clone/fetch/push、credentials、SSH/HTTPS、submodule、LFS/filter、签名验证；
- source status 的 deadline、取消和超大 worktree 资源预算；
- Rust broker 的 release signing/manifest 与 Host capability negotiation；
- SQLite T1/T2、candidate acceptance、canonical directory publication、GC/quarantine；
- Desktop/CLI 的显式 managed-task production consumer；
- 三平台完整 Host/worker crash chain。

因此下一步不应继续扩写“完整 Git”。应把这些验证分支保留为证据，从最新 main 重建少量生产 PR：
先交付 broker artifact/Host capability，再交付 source admission+baseline，最后接 M2 的 Write/Edit
T1/candidate/acceptance；网络 Git 继续留给外部工具或未来独立决策。
