# Resume 与 transcript 单权威对接、上游提交路线

更新：2026-09-07。本文区分已经进入 Apache 主线的基础、fork 的实现来源，以及最终交付；不把旧 stack 的测试通过当成新主线上的验证。

## 当前锚点与范围

- Apache 主线观察点：`b06eb02e6`。#3741（`8c491e64b`）与 #3857（`d07ff87c7`）已合并，不重复提交。
- Transcript 前置：[apache/maka#4879](https://github.com/apache/maka/pull/4879)，本轮验证基线 `86f1d76087a50b289bfd68d154fbf34c72a03d09`。这是 PR 快照，不是“已合并”声明。
- 原 fork 验证栈：[zhiiw/maka-agent#89](https://github.com/zhiiw/maka-agent/pull/89)。审计修复已推送到 `codex/resume-closure-audit-fixes@d8356064b`，五个提交是实现来源，不应整支直接提交上游。
- 本轮新基线分支：`codex/transcript-authority-acceptance`，直接基于 #4879。对接已提交 T2 的发布失败边界、Desktop 活跃 transcript 重订阅、Electron 验收和本路线；**没有移植整个 M3–M5 栈**。

本轮明确不做：多代自动恢复 owner、全 workspace 扫描优化、新增 importer 或第二套消息投影库。已有功能保留为后续提取来源，不代表现在必须全部合并。

尝试把 #4879 的净增量放回旧 fork 基线时，105 个变更文件出现大量冲突：主线已经拆分 AiSdkTurn、演进 modelProjection、Host 协议及 schema。试移植已撤销。最终策略是以新主线/#4879 为底，逐项提取仍缺失的 managed 能力；不把旧 StoredMessage writer、旧 schema 编号或 Host 协议覆盖回来。

## 1. Transcript 对接合同

主要不变量：**T2 已成功提交或被精确 adopt 后，任何消息投影、传输或遥测故障都不能把该工具重新描述为失败。**

| 项目 | Owner / 规则 |
| --- | --- |
| 工具结果、调用身份、modelProjection | Runtime 构造 canonical durable envelope |
| 成功接受事实 | SQLite T2 或 managed terminal transaction；不是 UI 或遥测 |
| transcript | #4879 的 RuntimeEvent → StoredMessage DTO 投影；业务执行不得另写 session_messages |
| 发布故障 | Runtime 的内部 committed 状态判断；fail-stop，不合成失败 T2/失败 tool_result |
| 恢复显示 | 重新读已提交 RuntimeEvents；不重新执行工具来补 UI |
| 回滚 | 可回滚本分支的发布保护/验收代码；不能把已迁移 transcript 重新变成业务双写，也不能降级打开不支持的 schema |

保留 #4879 的 `modelProjection`、完整事件 envelope、sourceEventIds、ordinal cursor、分阶段 legacy 转换和 WorkHub 自有消息域。没有为实验分支添加旧版本互通层；但已发布的主线数据和 #4879 的迁移协议不能按“无人使用的 Draft”处理。

Electron 测试还复现了活跃 Turn 刷新后只剩“等待模型输出”的问题：Main 持有的 replica overlay 是原订阅的初始快照，旧 renderer 收到的流式内容没有写回它（也不应该成为第二套持久化）。现在最后一个 transcript consumer 离开时记录该 generation；新 consumer 重用相同 generation 且 Turn 仍运行时，由原 subscription owner 重新取得 Host 有界 bootstrap。若 reload 保留同一 webContents、旧 close 尚未送达，同一 target 的新 consumer 也要求刷新。完成 Turn 和不同 target 仍共享订阅的消费者不为此额外重开；没有新增全局扫描或消息 writer。

对接验收必须区分：

1. Runtime 层：T2 后发布失败，只有原 terminal；managed adopt 不调用 generic T2。
2. Host reader：active/completed 都从同一个事件语义投影；legacy 混合顺序、转换重试由 #4879 的 owner 负责。
3. Desktop：重载、停止、重新启动不能让已完成消息消失、重复或把取消的 Turn 重新执行。
4. Managed 完整恢复：另需真实 Gitoxide/Host kill-restart、原 operation 身份、唯一 successor、外部 source 内容保留；下面的 fake-backend Electron 测试**不能替代**这一层。

#4879 最新审核提出的 legacy 混合历史排序问题仍须由该 PR 完成复验；本轮不另造 importer 绕过它，也不在此宣称 #4879 已获批准。全局 resume 扫描优化与该迁移正确性问题不是同一件事。

## 2. 推荐上游交付顺序

以下 fork 编号全部属于 **zhiiw/maka-agent**，不是 apache/maka。编号是代码来源，最终要按相对新基线的剩余差异重提，不能机械照搬旧 PR body 或整个 commit。

| 顺序 | 最终交付与主要不变量 | fork 实现来源 | 前置 / 合并条件 |
| --- | --- | --- | --- |
| 0 | Transcript 单权威及 T2 发布故障保护 | 上游 #4879；审计修复 `6e4a733b7` 的新接口移植 | #4879 自身迁移正确性门槛通过；本分支验收 |
| 1 | Mutation acceptance 剩余增量：参数、纯转换、exact terminal、reservation 原子释放 | [#40](https://github.com/zhiiw/maka-agent/pull/40) | 先扣除 #3741 已合并内容；不重复迁移 schema |
| 2 | Candidate reopen、accepted-ref 修复、prepared pure mutation 恢复 | [#43](https://github.com/zhiiw/maka-agent/pull/43)；审计 `d4f7c3d37` | 1；原 T1、candidate 与 terminal 身份一致；真实 kill/reopen |
| 3 | Packaged Gitoxide 与 managed session owner | [#41](https://github.com/zhiiw/maka-agent/pull/41) | 2；适配最新 Host 选举/握手，不恢复旧 packaged authority |
| 4 | Accepted-world 文件能力与 Git/非 Git Source Admission | [#44](https://github.com/zhiiw/maka-agent/pull/44)、[#45](https://github.com/zhiiw/maka-agent/pull/45) | 3；Read/Glob/Grep/Write/Edit 同一 accepted tree；不依赖 M5 |
| 5 | Desktop 文件任务入口与显式 continuation | [#46](https://github.com/zhiiw/maka-agent/pull/46)、[#42](https://github.com/zhiiw/maka-agent/pull/42)；审计 `e185336f0`、`8426d786a` | 0–4；profile 在创建 Session/T1 前确定；源目录内容漂移不自动覆盖 accepted history |
| 6 | Accepted diff / review、隔离导出与 restore | [#48–#54](https://github.com/zhiiw/maka-agent/pull/48) | 5；导出不静默覆盖 source；可按 review+export 和 restore 分两次交付 |
| 7 | 历史浏览、Undo-as-successor、rebaseline/new epoch、source branch publish | [#55–#61](https://github.com/zhiiw/maka-agent/pull/55) | 6；Undo 不抹除历史，rebaseline 不偷偷改旧 epoch，publish 显式授权 |
| 8 | Retention / GC / lifecycle crash | [#62–#63](https://github.com/zhiiw/maka-agent/pull/62)、[#79–#80](https://github.com/zhiiw/maka-agent/pull/79) | 6–7；先列 durable GC roots，pending mutation/continuation 不得被回收 |
| 9 | M5 命令/toolchain/dependency/external-effects | [#64–#78](https://github.com/zhiiw/maka-agent/pull/64)、[#81–#89](https://github.com/zhiiw/maka-agent/pull/81) | M3 文件产品稳定后再逐 owner 提取；不是文件 Resume 的前置 |

[#47](https://github.com/zhiiw/maka-agent/pull/47) 的自动恢复增强暂缓；本轮不为追求“无人值守完整循环”扩大实现。#51 路线文档应吸收进对应交付，#85 的未发布协议清理也应吸收进新基线提取，不单独制造升级兼容 PR。

旧栈的真实基础链是 **#40 → #43 → #41 → #42 → #44 → #45 → #46 → #47**，不是编号顺序。新路线将 #42 的 continuation 与产品入口按真实依赖重新整理；提取 #44 时必须验证其能否脱离旧 #42 base 独立构建，不能仅凭文件名声称可并行。

### 每次提取的操作纪律

1. fetch 后记录最新 upstream/main SHA；前置未合并时明确 stacked base，前置合并后再平铺。
2. 写 extraction ledger：源 commit / 文件 / 测试 / 已在 main / 仍需移植 / 刻意删除。
3. 按功能移植，不 cherry-pick merge，不把旧 Host/UI/发布冲突顺手并入。
4. `git range-diff` 检查等价迁移；路径级 diff 检查 owner 边界。遇到接口重写时解释语义差异，不能要求字节一致。
5. 当前 Windows/macOS/Linux 对应测试都跑在最终 base 上；旧栈证据不继承为新 PR CI。
6. Draft/Ready 按实际风险和证据判断；单纯“暂无生产消费者”不再自动否决基础设施，但不能把基础设施描述成 Desktop 可用能力。

## 3. Mac Electron 验收

本轮新增 `apps/desktop/e2e/transcript-recovery.spec.ts`，四个真实 Electron/Host/SQLite 场景：

- 两个完成 Turn 连续 renderer reload，顺序、条数不变。
- 流式中 renderer reload，重新订阅后只出现一份输出，随后 Stop 收敛。
- Stop 后 reload，保持 terminal；新消息是新 Turn，不是隐式恢复旧 Turn。
- Desktop graceful restart，使用同一隔离 userData，完成历史可读且可继续发新消息。

模型使用仓库 deterministic fake backend，不需要 API Key、不访问真实模型。每个用例创建自己的临时目录，不打开或删除你的正式 Maka 数据。Desktop restart 不等于 Host SIGKILL，更不等于断电证明。

在本分支根目录，使用仓库 Node 24 合同：

```bash
node --version
npm ci
npm --workspace @maka/desktop run e2e:transcript
```

第一次会安装 Electron 和构建依赖；**这组 transcript 测试不需要 Rust/Gitoxide helper**。Mac 保持桌面登录且可启动 Electron，初次系统安全提示需正常批准测试应用。不要设置 `platform=darwin` 来模拟 Mac；测试应运行在真实 Mac。

已构建后重复三轮（失败不自动重试掩盖）：

```bash
npm --workspace @maka/desktop run e2e:transcript:run -- --repeat-each=3 --reporter=line
```

额外已有验收可选：

```bash
cd apps/desktop
npx playwright test --config e2e/playwright.config.ts streaming-remount.spec.ts new-task-reload.spec.ts partial-history-notice.spec.ts --reporter=line
```

失败反馈附：分支/commit、`node --version`、macOS 版本、完整 Playwright 错误输出与 `apps/desktop/e2e/test-results`（含失败截图和 trace）。不要为了“通过”删除正式数据库、打开自动 retries 或放宽为只检查按钮存在。

## 4. 平台保证与当前交付边界

| 平台 | 本轮可执行测试合同 | 不可据此宣称 |
| --- | --- | --- |
| Windows | 真实 Electron transcript reload / Stop / graceful restart；Runtime durable-boundary | 已证明全部 managed Host/helper crash 或断电恢复 |
| macOS | 同一脚本在真实 Mac 运行，不含 `/var` 固定路径假设 | 本机 Windows 通过等同 Mac 已通过 |
| Linux | 有图形会话或既有 CI Xvfb 的同一 Electron 用例 | 只跑 Node 测试等于 Desktop 验收 |

这一步完成的是 transcript 新基线的窄对接与产品验收。整个旧 fork 的 M3/M4/M5 重建、混合 legacy 数据迁移批准、完整 managed Desktop crash matrix，仍须按上表继续交付。

### 本轮实际验证记录

- Core、Storage、MCP、Runtime、Runtime Host、Computer Use、UI 与 Desktop 完整构建通过。
- Runtime durable-boundary + Host transcript reader/protocol + Desktop observer/range：134/134，通过，无跳过。
- E2E budget 单元测试：5/5；清单检查 36 个测试 / 18 个文件。
- 新增四个真实 Electron 场景：Windows 4/4，通过，约 1.2 分钟；Mac/Linux 本轮未执行。
- T2 发布故障回归先得到 2 条相互矛盾的 tool_result，再修复为 1 条；流式 reload 先复现空白记录，再由 Host bootstrap 修复。没有用 retries 隐藏失败。
- 两个 reader fixture 原先只关闭 root lease、未关闭 execution store SQLite facade，Windows 清理报 EBUSY；已补齐先关 stores 再关 root 的测试生命周期。
- `git diff --check` 通过。没有运行完整仓库 CI，也没有宣称 #4879 其他审查问题均已解决。
