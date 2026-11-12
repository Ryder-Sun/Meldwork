<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-cn.png" alt="Meldwork README banner" width="100%">
</p>

# Meldwork：让 Agent 自主协作推进任务

**提出目标，让 Agent 们协作完成。Meldwork 把你已有的 Agent 组织成一个工作小组，共享上下文、讨论方案、协作执行并相互检查，减少你在它们之间转述、催办和整合结果的工作。**

Meldwork 是一个本地优先的多 Agent 协作工作空间，用来连接你已经在电脑上使用的 Agent 工具。你选定参与者、目标、上下文和权限后，自动讨论中的 Agent 可以接续彼此的工作，请求同伴补充或检查，并在授权范围内推进任务。它也支持单个 Agent 的直接会话和多个 Agent 的独立并发回复，覆盖研究、分析、写作、规划、评审和实施。

你无需安排每一轮发言，但仍负责目标、权限和关键决策。遇到信息缺失、权限请求或需要取舍的问题时，任务可能等待你处理。工作区写入需要明确授权；协作过程、运行状态和产物保存在本地，方便回看和继续工作。

<p align="center">
  <a href="https://github.com/Ryder-Sun/Meldwork/releases"><img src="https://img.shields.io/badge/下载-macOS-1677FF?style=plastic&amp;logo=apple&amp;logoColor=white" alt="下载 macOS 安装包" height="26"></a>
  &nbsp; <a href="https://youtu.be/ttyJxo1s9ns"><img src="https://img.shields.io/badge/演示-YouTube-EC4899?style=plastic&amp;logo=youtube&amp;logoColor=white" alt="在 YouTube 观看演示" height="26"></a>
  &nbsp; <a href="architecture.md"><img src="https://img.shields.io/badge/架构-文档-8B5CF6?style=plastic" alt="项目架构文档" height="26"></a>
  &nbsp; <a href="LICENSE"><img src="https://img.shields.io/badge/许可-查看-14B8A6?style=plastic" alt="查看许可证" height="26"></a>
  &nbsp; <a href="README.md"><img src="https://img.shields.io/badge/language-English-1677FF?style=plastic" alt="Switch to English" height="26"></a>
</p>

## Meldwork 适合什么工作

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <a href="assets/meldwork-agent-discovery.png"><img src="assets/readme/agent-discovery.svg" alt="Agent 发现" width="240" height="150"></a>
      <p><sub>Agent 发现</sub></p>
    </td>
    <td width="33%" align="center" valign="top">
      <a href="assets/meldwork-auto-discussion.png"><img src="assets/readme/auto-discussion.svg" alt="自动讨论与运行详情" width="240" height="150"></a>
      <p><sub>自动讨论与运行详情</sub></p>
    </td>
    <td width="33%" align="center" valign="top">
      <a href="assets/meldwork-direct-multimodal.png"><img src="assets/readme/direct-multimodal.svg" alt="多模态直接会话" width="240" height="150"></a>
      <p><sub>多模态直接会话</sub></p>
    </td>
  </tr>
</table>

当一个任务需要多个 Agent 共同推进，而你不想反复传递上下文、协调下一步时，Meldwork 更适合：

- 研究与信息综合：结合本地 Agent 工具和明确选择的知识源；
- 产品、市场、运营和技术分析；
- 写作、规划、评审和结构化文档工作；
- 处理本地文档、图片、音频、视频、PDF、代码和配置文件的多模态工作；
- 在授权工作目录内执行、由其他 Agent 检查成果并继续修改的实施工作。

## 一个任务如何在 Meldwork 中推进

1. **选择**一起处理任务的 Agent。
2. **限定**目标、工作目录、上下文、附件、Skill、知识源和权限。
3. **协作**：启动 Auto Discussion，让 Agent 讨论方案、接续执行并检查成果；也可选择直接会话或并发回复。
4. **决策**：在需要补充信息、授权或取舍时介入。
5. **查看结果**：检查交付物，必要时提出修改，让工作继续推进。

## 协作模式

| 模式 | 运行方式 | 适合场景 |
| --- | --- | --- |
| **直接会话** | 一个已选 Agent 在适配器支持时保持对话和原生会话。 | 聚焦研究、写作、分析或执行。 |
| **并发回复** | 已选 Agent 收到同一份冻结任务快照，并按稳定顺序返回独立回复。 | 在选择方案前比较不同视角。 |
| **Auto Discussion V4** | Agent 独立提出方案后，接续讨论、请求同伴贡献、在授权范围内执行并检查成果。交付负责人判断任务进度，必要时请求用户决策；支持时保持原生会话。 | 希望减少人工协调的多步骤协作任务。 |

参与者始终由用户选择。从更大候选池自动选人组队不属于当前预览版。

## 过程可回看，工作可继续

Meldwork 在本地保留任务上下文、Agent 回复、运行状态和产物，方便了解任务如何推进、哪里遇到阻塞，以及接下来需要处理什么。Run Ledger 保留阶段、参与者、尝试、产物、恢复状态和人工审批门；诊断工具输出与敏感运行信息留在 Electron 主进程边界内。

过程记录帮助检查协作情况，不代表每条结论都经过事实核验。Agent 的相互检查也不能保证结果正确，重要交付物仍需按实际用途验收。

## 核心设计与同类工具的区别

向 Meldwork 提供原始需求即可。在自动讨论模式下，Agent 首轮并行提出方案，随后在共享任务上下文中自行讨论和 review，协商分工、执行工作并验证候选结果，无需你逐步协调。整个流程以交付可校验、可溯源的成果为目标，附带来源引用、证据与审阅记录。只有缺少必要授权，或遇到 Agent 无法在约定范围内解决的阻塞时，才需要你介入；日常流程不要求你逐轮批准方案或在 Agent 之间传话。

<table><tr>
<td width="50%"><a href="assets/readme/coordination-models-zh-CN.png"><img src="assets/readme/coordination-models-zh-CN.png" alt="Meldwork：并行提案并在共享上下文中自主协作。Orca：隔离的工作树。Munder Difflin：主管与 Agent 通过共享记忆和邮箱协作。" width="100%"></a></td>
<td width="50%"><a href="assets/readme/organization-models-zh-CN.png"><img src="assets/readme/organization-models-zh-CN.png" alt="OpenRig：持久团队。Paperclip：组织目标与治理。Rig：Rust 库与可扩展 CLI。" width="100%"></a></td>
</tr></table>

| 项目 | 工作主要围绕什么组织 |
| --- | --- |
| **Meldwork** | 原始需求 → 并行提案 → 共享上下文中的自主讨论、审阅与执行 → 可校验、可溯源的交付物 |
| [Orca](https://github.com/stablyai/orca) | 代码工作空间与 worktree；也支持协调 Agent 分解任务并管理 workers |
| [Munder Difflin](https://github.com/HarnessMD/munder-difflin) | Michael 协调的 Agent 办公室，通过共享记忆与邮箱协作 |
| [Paperclip](https://github.com/paperclipai/paperclip) | 组织目标、任务归属、角色、预算与审批 |
| [OpenRig](https://github.com/mvschwarz/openrig) | 有 Lead 与专业角色的持久团队，以及持续积累的上下文与工作归属 |
| [Rig](https://github.com/0xplaygrounds/rig) | Rust LLM 应用开发；当前主分支另含基于插件扩展的终端 Agent |

如果你希望选定的原生 Agent 在本地桌面流程中协商分工、共同检查一项任务，可以选择 Meldwork。其他工具也有共享上下文、交叉审阅和人工审批；值得比较的是具体协作协议及其整合方式。一致意见不保证结果正确，这份对比也没有证明 Meldwork 的任务效果更好。图中展示选定的组织方式，并非完整架构。Rig 与 OpenRig 是两个项目；[来源与对比口径](assets/readme/RELATED_TOOLS.md)核对于 2026-11-12。

## General Agent 目录

支持的 Agent、原生配置目录与认证说明见 [独立 catalog](CATALOG.zh-CN.md)，安装及能力矩阵见 [桌面指南](desktop/README.md)。

## 上下文与本地边界

Meldwork 作为本地 Electron 应用运行。对话、群组配置、运行记录和应用管理的附件保存在本地用户数据目录。渲染进程只通过受约束的 preload API 获取校验后的状态；可执行路径、凭据、原生会话引用、Skill 路径和任意 Shell 权限都留在主进程中。

选定的 Agent 仍可能把 Prompt、附件或 Skill 发送到其自身 CLI 凭据对应的模型服务商。知识访问必须明确选择并受边界约束：当前实现支持本地 Obsidian 检索，以及由本地 CLI 管理的飞书或钉钉访问模式。Local-first 描述的是 Meldwork 的数据和协作位置，不代表 Agent 使用的模型服务商一定离线。

## 从源码运行

前置条件：Node.js `22.12+` 和 npm。

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

分发构建前运行：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

## 文档

- [架构与产品边界](architecture.md)
- [桌面端设置与 Agent 矩阵](desktop/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

Meldwork 以 [Apache License 2.0](LICENSE) 开源。在许可证条款范围内，可以商用、私用、修改和再分发。商用无需另行授权或支付许可费。Apache-2.0 不授予商标权；详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。
