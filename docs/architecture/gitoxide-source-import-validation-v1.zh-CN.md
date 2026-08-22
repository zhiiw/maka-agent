# Gitoxide source import validation v1

状态：验证切片，堆叠在 repository admission、successor CAS、fresh projection 与 projection
observation 之后；没有生产消费者，保持 Draft。

## 1. 主要不变量

本切片只验证：

> broker 从 source repository 重新读取并匹配调用方冻结的 exact SHA-1 HEAD，只复制该 commit 的
> reachable tree/blob 到一个此前不存在的 Maka-owned bare repository；它以相同 tree 构造一个
> 无父提交、身份与时间固定的 baseline commit，并通过 `MustNotExist` 发布 `refs/maka/*` baseline。
> 只有完整响应返回后 destination 才能成为候选 artifact；任意失败或进程中断留下的 destination
> 必须整体丢弃，禁止局部续写或推断成功。

它不复制 source commit/history，不创建 alternates，不执行 clone/fetch，不读取 source worktree 的
dirty/untracked/ignored 状态，也不接入 SQLite、Runtime Host 或 Desktop/CLI。

## 2. Owner 与证据

| 项目 | v1 约束 |
| --- | --- |
| source identity | isolated + strict-config 打开的 SHA-1 repository；实际 HEAD 必须等于冻结 OID |
| imported identity | 每个 blob/tree 写入 destination 后必须得到与 source 完全相同的 Git object OID |
| history boundary | 不复制 source commit；baseline 是固定 signature/time/message、零父提交的新 commit |
| destination | 路径必须不存在；已有空目录、文件、symlink 或 repository 一律拒绝接管 |
| publication | baseline ref 只允许 `refs/maka/*`，用 `PreviousValue::MustNotExist` 发布 |
| Git execution | broker 不 spawn Git；测试把 broker `PATH` 清空，Git CLI 只负责 fixture 与独立验收 |
| hooks/config | 删除初始化模板 hooks 并创建空 hooks 目录；不创建 alternates |
| tree policy | 与 fresh projection 相同：只接受 tree、100644/100755 blob，拒绝 symlink/submodule、`.git`、`.gitattributes`、非 UTF-8 和大小写/NFC collision |
| resource limits | 单 blob 64 MiB、总计 2 GiB、最多 200,000 文件 |

## 3. 原子性、失败与回滚

跨 source 与 destination object database 不存在原子事务。本切片将边界定义为 fresh artifact
publication，而不是伪造跨库原子性：

```text
read source HEAD and require exact frozen OID
  -> require destination nonexistent
  -> initialize fresh bare repository
  -> copy and re-hash all reachable tree/blob objects
  -> build deterministic baseline commit
  -> publish absent baseline ref
  -> return complete source_imported receipt
```

- stale HEAD 在 destination 创建前失败；上层应重新 admission，不能静默导入新 HEAD。
- destination 已存在时不读写其中任何内容；不存在“接管已有目录”的兼容分支。
- object/path/quota/ref publication 任一步失败：整个 destination 是 untrusted partial artifact。
- process kill：没有 durable success fact；上层删除整个 destination，用新的 fresh path 重试。
- source HEAD 在首次精确匹配后继续前进，不影响已经按 OID 选择的 immutable tree；这不是 drift。

真实 child-process 测试在 64 MiB blob 导入期间终止 broker，整体删除 partial bare repository，并由
新进程从同一 source HEAD 完整导入。它证明 process-crash discard/retry，不证明 power-loss durability。

## 4. 安全边界

source repository 是内容来源，不是执行 authority。broker 不执行 hooks、filters、smudge、submodule、
credential helper 或 transport helper，也不把 source config、objects/info/alternates 带入 destination。

source eligibility（是否是允许的 root、是否 clean、是否包含 source-side unsafe config）仍属于独立的
T1 前 admission owner。本切片只接受已经冻结的 repository path + HEAD OID，不能被包装成“完整 source
workspace admission”。

## 5. 平台能力矩阵

| 平台 | 当前可持续验证 | 明确限制 |
| --- | --- | --- |
| Linux | exact HEAD/tree import、100755、fresh destination、kill/discard/retry | 不承诺 power-loss；source eligibility 未接入 |
| macOS | 同 Linux | 不承诺 F_FULLFSYNC；不处理平台签名发布 |
| Windows | exact object identity、fresh destination、kill/discard/retry | executable bit 只保留在 Git tree，不映射 Windows ACL |

三平台使用同一 locked Cargo suite。Windows 本地当前 20/20 通过；Linux/macOS 由现有 Gitoxide
workflow 在远程持续验证。

Windows x64 未专门 strip 的 release broker 为 8,265,728 bytes（约 7.88 MiB），相对 projection
observation probe 增加 91,136 bytes（约 0.09 MiB）；locked dependency closure 没有变化。

## 6. 验证后的架构结论

至此 Gitoxide 已经用最小数据面证明了：

```text
source exact SHA-1 HEAD
  -> Maka-owned immutable baseline
  -> exact-base successor ref CAS
  -> fresh filesystem projection
  -> exact blob/type/path drift observation
```

这足以继续评估其作为 managed workspace correctness core；仍不足以替代完整 Git CLI。clone/fetch、
credentials、submodule、LFS/filter、签名验证、SHA-256、source eligibility、canonical directory publication、
SQLite T1/T2 和生产 Host lifecycle 都没有被本切片证明。
