# Gitoxide projection observation validation v1

状态：验证切片，堆叠在 fresh projection 之后；无生产消费者，保持 Draft。

## 1. 主要不变量

本切片只验证：

> observer 以 immutable accepted commit/tree 为唯一期望状态，逐项验证 projection 的 tracked
> path、entry type、Git executable bit 与 exact blob object identity，并递归拒绝任何额外路径。
> clean 只是一条可重算 observation，不是 durable truth；任一 mismatch 都返回结构化 drift，绝不
> 修改 projection 或 accepted ref。

它不接受 mtime/size 作为最终证据，不使用 Git index/status，也不把 projection 自己提供的 metadata
当作 expected truth。

## 2. Owner 与证据

| 项目 | v1 行为 |
| --- | --- |
| expected owner | Maka-owned SHA-1 object database 中的 exact accepted commit/tree |
| current observer | broker 对 projection root 的只读遍历 |
| content identity | 对打开文件的 handle 重取 size，bounded read 后按 Git `blob <size>\0<bytes>` 计算 SHA-1 |
| path identity | expected tree 的 UTF-8 canonical path + NFC/lowercase collision fence |
| type | directory/regular file 必须精确匹配；symlink、junction-like reparse/type replacement fail closed |
| mode | Linux/macOS 比较 Git executable bit；Windows v1 不把模拟 POSIX mode 当事实 |
| extras | 递归枚举 projection；任何不在 expected tree 的 path 都是 drift，包括 ignored/build output |
| 资源边界 | 复用单文件 64 MiB、总计 2 GiB、200,000 文件上限；打开后再校验 handle size，并最多读取 expected size + 1 |

## 3. 状态与失败

成功返回：

```text
projection_observed
state = clean
acceptedCommitOid / acceptedTreeOid
filesObserved / bytesRead
```

语义漂移返回 exit 3 + `projection_drifted`，至少区分：

- expected path missing/unreadable；
- file/directory/type replacement；
- size/content/mode mismatch；
- unexpected path；
- unsupported entry/path/collision。

repository/object 读取等无法完成 observation 的 operational failure 返回 exit 1。两类失败都不修改
Git 或文件系统；上层只能 quarantine/park 或从 accepted commit 重建，禁止把 unreadable 当 clean。

## 4. 并发边界

一次目录遍历不是跨文件原子 snapshot。因此 `clean` 的正确使用前提是：被观察的是 Maka-owned、尚未
公开的 fresh staging，且 publication owner 是唯一 writer。对已经公开的 canonical projection，
observer 能检测稳定 drift，但不能阻止另一个同用户进程在检查后继续修改。

这也是为什么后续 publication 仍应使用 fresh-directory rotation，而不是“observe clean 后在原目录
继续写”。如果威胁模型要求抵御恶意同用户进程，需要平台级 directory capability；重复 hash/stat
不会把目录遍历变成事务。

## 5. 验证矩阵

共享 broker suite 当前覆盖：

- exact projection -> clean；
- 同长度内容篡改 -> blob mismatch；
- tracked path 删除；
- tracked file 替换成 directory；
- 额外 untracked path；
- Linux/macOS executable-bit drift；
- 大文件 bounded materialize 的真实 process kill/discard/retry（前一切片）。

| 平台 | 可持续验证 | 明确限制 |
| --- | --- | --- |
| Linux | content/type/extra/missing/mode | 非原子多文件 snapshot；不防恶意同用户 race |
| macOS | 同 Linux | 不证明 APFS power-loss ordering |
| Windows | content/type/extra/missing | 不把 Node/Rust 模拟 mode 或 ACL 当 Git executable bit |

Windows x64 未专门 strip 的 release broker 为 8,174,592 bytes（约 7.80 MiB），相对 fresh
projection probe 增加 35,840 bytes（约 0.03 MiB）；locked dependency closure 没有变化。

## 6. 下一步

下一切片只验证 source import：从经过 eligibility 检查的 SHA-1 source HEAD，把 reachable commit/tree/
blob 复制到一个全新的 Maka-owned bare repository，并在 exact ref CAS 后才发行 baseline observation。
网络、clone/fetch、SHA-256 和生产 Host 接线继续不进入该切片。
