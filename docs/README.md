# Meldwork 文档

Meldwork 的候选定位是 **本地优先、跨 Agent 的任务与交付工作台**：用户更换 Agent 或中断重启后，仍能继续工作并检查交付依据。群聊与 Decision Review 是可选机制；首批商业场景需要由真实客户任务、付费和复购选出，尚未锁定代码合并或非代码方案复核。

当前项目围绕本地 Agent CLI、直聊/群组、上下文、权限和运行记录建设。本轮市场调研未重新验收发布包；具体能力以相应版本和运行验证为准，不沿用旧文档的分支状态作发布证明。动态组队、Outcome Network 等属于待验证方向；远程群成员和云会话存储不在本轮范围。

## 战略主线

| 文档 | 作用 |
| --- | --- |
| [产品战略](product-strategy.md) | 2026-09-09 决策摘要：市场证据、跨 Agent 价值、首单建议与继续投入条件；来源快照为 09-08 |
| [Harness 与 Agent 组织层](harness-engine-strategy.md) | 协议对象、屏障、权限、责任、OutcomeReceipt、Fit 和架构演进 |
| [产品迭代规划](product-iteration-plan.md) | 90 天验证、阶段门槛、指标、停止条件和路线图 |
| [2026-09-08 商业化深度调研](research/meldwork-commercial-research-2026-09-08.md) | 七组竞品、实际价格、公开用户反馈、研究反证、中国/海外商业路径与迭代判断 |
| [调研证据与缺口](research/meldwork-commercial-evidence-2026-09-08.md) | 30 项引用来源、用户短摘、检索失败、证据局限和历史推论更正 |
| [2026-09-04 历史调研](research/meldwork-market-decision-research-2026-09-04.md) | 历史快照；漏斗、刚需与竞争空白等推论已由 09-08 调研更正，不作为当前决策依据 |
| [跨设备可靠性优化方案](reliability-optimization-plan.md) | Agent Readiness 事实源收敛：跨设备安装 bug 根因、选型矩阵、风险与实施计划 |
| [2026-08 深度竞品调研](research/meldwork-competitive-landscape-2026-08-16.md) | Buzz、Pragma 与同赛道产品的代码、采用、商业、风险和差异化分析 |
| [2026-08 深度竞品调研 PDF](research/meldwork-competitive-landscape-2026-08-16.pdf) | 用于评审和归档的正式报告版本 |

## 产品、运行与信任边界

- [流程](flows.md)：启动、任务、Agent 调用、恢复和外部副作用。
- [权限边界](permissions.md)：Renderer、Preload、Main、Agent 和 Connector 的信任边界。
- [自动化清单](automation.md)：当前自动讨论、运行记录、安装器与外部适配边界。
- [变量与密钥](variables.md)：Agent 凭证和本地运行变量。
- [架构](../architecture.md)：当前 Electron、Main、Connector 和本地数据边界。

## 契约与验证

- [Agent Connector SDK](agent-connector-sdk.md)：当前 Connector Manifest、CredentialRef、Run Event 和注册契约。
- [本地 Skill 契约](local-skill-contracts.md)：Skill 发现、选择、快照和目标范围。
- [评测 Harness](eval-harness.md)：质量、成本、兼容性和未来 Proposal 对照评测。
- [测试与验证](tests.md)：已执行检查、历史基线、缺口和发布门槛。

## 发布、演示与传播

- [V1.0.5 版本说明](releases/Meldwork-V1.0.5.md)：CLI 检测、群聊恢复与本地预发布验收。
- [发布与分发清单](public-mvp-release.md)：预览版和公开分发门槛。
- [macOS 签名与公证](macos-signing.md)：Developer ID、Notarization 和 Gatekeeper 验收。
- [核心演示场景](demo-recording-scenarios.md)：当前产品证明与未来概念素材的边界。
- [宣传视频脚本](promo-video-scripts.md)：品类片、产品证明片和短版脚本。
- [视觉生成 Prompt](visual-generation-prompts.md)：README Banner 与组织层 Harness 图的 Image 2 生成规范。

## 文档口径

| 标签 | 含义 |
| --- | --- |
| **Today** | 当前仓库、测试和发布客户端可以直接证明的能力 |
| **Next** | 下一阶段实验或正在实现，但还不能作为发布承诺 |
| **Future** | 只有验证门通过后才投入的产品方向 |
| **Commercial hypothesis** | 定价、Pilot、续费和企业治理假设 |

对外宣传必须紧邻写清边界。Agent 自报完成不等于 Verified，用户点击查看不等于 Adoption，路线图也不等于发布能力。

## 根目录入口

- [English README](../README.md)
- [中文 README](../README.zh-CN.md)
- [许可证](../LICENSE)
- [商业使用政策](../COMMERCIAL_USE.md)
- [声明](../NOTICE)
