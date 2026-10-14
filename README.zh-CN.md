<!-- <p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logos/meldwork-wordmark-v3-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="frontend/public/logos/meldwork-wordmark-v3.svg">
    <img src="frontend/public/logos/meldwork-wordmark-v3.svg" alt="Meldwork" width="360">
  </picture>
</p> -->

<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-cn.png" alt="Meldwork README banner" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Meldwork 为 AI Agent 构建组织层

**多数工具是在帮人类管更多 Agent；Meldwork 解决的是另一件事：让多 Agent 协作变得可见、可追责、可复用。**

当前预览版是一个面向已支持本地 Agent CLI 的本地工作单元。它把参与者、上下文、协作边界、运行状态和人类复核放在同一个工作空间里。已选 Agent 现在可以并发回复，也可以围绕同一目标先独立提案，再根据讨论互相指定下一位参与者，最后协作完成工作并进行复核。

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.4/Meldwork-0.1.4-arm64.dmg"><strong>下载 Meldwork V1.0.4 Apple 芯片 macOS 版</strong></a>
  · <a href="architecture.md">架构</a>
  · <a href="LICENSE">许可证</a>
</p>

## 适合谁

当你有以下需求时，Meldwork 更适合：

- 已经安装多个本地 Agent CLI，希望让同一任务跨 Agent 协作；
- 需要在代码评审、研究或产品分析中获得独立判断，再选择方案；
- 需要在写入工作区前检查可追溯的运行轨迹、证据并保留人工复核。

## 工作流程

1. **选择**本地 Agent 和参与者。
2. **限定**目标、工作目录、上下文和权限。
3. **运行**直接会话、并发回复或 Auto Discussion V4。
4. **复核并采用**结果、证据和待处理的人工审批门（Human Gate），再写入工作区。

## 协作模式

| 模式 | 运行方式 | 适合场景 |
| --- | --- | --- |
| **直接会话** | 一个已选 Agent 在适配器支持时保持对话和原生会话。 | 使用单个 Agent 完成聚焦工作。 |
| **并发回复** | 已选 Agent 收到同一份冻结任务快照，并按稳定顺序返回独立回复。 | 在选择方案前比较不同路径。 |
| **Auto Discussion V4** | 首轮并发提案。后续轮次由 Agent 根据讨论结果通过最后一行的 `@Agent` 决定下一位参与者；@ 一个 Agent 时单独运行，@ 多个 Agent 时并发运行。每个 Agent 在同一任务中持续使用原生会话。 | 需要讨论、灵活分工和复核的多轮工作。 |

参与者始终由用户选择。从更大候选池自动选人不属于当前预览版。

## Meldwork 与相邻产品的区别

Meldwork 是面向多 Agent 评审与决策可追溯性的本地优先 AI Agent 工作空间，不是终端、云端 Agent Fleet、通信网络或可编程编排框架。它把你已经在使用的本地 Agent 工具连接到可形成决定的评审流程，并在一个本地工作单元中保留独立发现、证据、责任和人工采用决定。

| 项目 | 类别 | 主要解决什么 | Meldwork 的区别 |
| --- | --- | --- | --- |
| [Buzz](https://github.com/block/buzz) | Agent 通信网络 | 身份、频道、事件和持续协作。 | 面向单个 Case 的独立判断，以及有证据支持的 Decision 和 Disposition。 |
| [Pragma](https://github.com/pqpo/pragma) | 方法与工作流运行时 | 可复用的 Expert、Flow、Memory、Evaluation 和 DSL 资产。 | 在流程固定前保留分歧、复验和采用记录。 |
| [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) | 可视化 Agent 公司 | Boss -> Manager -> Workers，以及任务和活动状态。 | 追踪 Finding -> Evidence -> Decision -> Disposition，不让中心经理隐藏分歧。 |
| [Superset](https://github.com/superset-sh/superset) / [Conductor](https://www.conductor.build/) / [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 并行编码工作台 | 并行 Coding Agent、隔离工作区、Diff 和 Merge。 | 面向异构 CLI 的本地优先评审，不以终端数量、Worktree 吞吐量或云 Sandbox 竞争。 |
| [cmux](https://github.com/manaflow-ai/cmux) | Agent 原生终端 | 低摩擦终端、通知和多任务处理。 | 增加冻结上下文、独立结果和人工采用门。 |
| [Nimbalyst](https://github.com/nimbalyst/nimbalyst) | Agent 与 Artifact 工作空间 | 并行 Agent，以及 Markdown、Mockup 和 Diagram。 | 在 Artifact 旁边保留证据和可追责的决定。 |
| [Paperclip](https://github.com/paperclipai/paperclip) | Agent 组织管理 | 公司、岗位、预算、审批和组织图。 | 将责任落在真实 Finding 和结果上，而不是虚拟公司。 |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Agent 通信基础设施 | 身份、收件箱、Thread 和 advisory file lease。 | 在传输层之上保留 Case 和评审语义。 |
| LangGraph / CrewAI / AutoGen / OpenAI Agents SDK / Google ADK | 可编程多 Agent 框架 | 面向开发者的 Graph、角色、路由、工具和审批。 | 团队无需编写编排框架代码即可获得桌面评审流程。 |
| Warp Oz / Devin / Factory / OpenHands Cloud | 云端 Agent 控制面 | 托管 Sandbox、远程执行和 Agent Fleet。 | 在本地 Electron 工作单元中使用现有 CLI，并保持本地数据边界。 |

## 运行示例

<table>
  <tr>
    <th>本地 Agent 检测</th>
    <th>多 Agent 评审</th>
    <th>直接会话中的多模态工作</th>
  </tr>
  <tr>
    <td align="center"><a href="assets/meldwork-agent-discovery.png"><img src="assets/meldwork-agent-discovery.png" alt="Meldwork 本地优先多 Agent 工作空间检测 Agent CLI" width="320" height="205"></a></td>
    <td align="center"><a href="assets/meldwork-multi-agent-review.png"><img src="assets/meldwork-multi-agent-review.png" alt="Meldwork 多 Agent 协作、证据与人工复核" width="320" height="205"></a></td>
    <td align="center"><a href="assets/meldwork-direct-multimodal.png"><img src="assets/meldwork-direct-multimodal.png" alt="Meldwork 直接 Agent 工作空间处理本地文件和媒体" width="320" height="205"></a></td>
  </tr>
</table>

示例：把同一份变更评审上下文交给 Codex、Claude Code 和 Gemini CLI，比较各自的独立发现，再只采用你批准且有证据支持的结果。

## 支持的本地 Agent CLI

当适配器和 CLI 版本兼容时，Meldwork 会检测并调用已安装的命令：

<table>
  <tr>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/codex.svg" alt="Codex logo" width="32" height="32"><br><strong>Codex</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/hermes.png" alt="Hermes logo" width="32" height="32"><br><strong>Hermes</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/openclaw-transparent.png" alt="OpenClaw logo" width="32" height="32"><br><strong>OpenClaw</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/workbuddy.png" alt="WorkBuddy logo" width="32" height="32"><br><strong>WorkBuddy</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/pi.svg" alt="Pi Agent logo" width="32" height="32"><br><strong>Pi Agent</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/kimi.png" alt="Kimi Code logo" width="32" height="32"><br><strong>Kimi Code</strong></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/mimo.svg" alt="MiMo Code logo" width="32" height="32"><br><strong>MiMo Code</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/claude.png" alt="Claude Code logo" width="32" height="32"><br><strong>Claude Code</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/gemini.svg" alt="Gemini CLI logo" width="32" height="32"><br><strong>Gemini CLI</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/opencode.svg" alt="OpenCode logo" width="32" height="32"><br><strong>OpenCode</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/qwen.svg" alt="Qwen Code logo" width="32" height="32"><br><strong>Qwen Code</strong></td>
    <td align="center" valign="top" width="16.66%"><img src="frontend/public/agent-logos/opencodereview.svg" alt="OpenCodeReview logo" width="32" height="32"><br><strong>OpenCodeReview</strong></td>
  </tr>
</table>

已批准的 Agent Connector 可通过 [Agent Connector SDK](docs/agent-connector-sdk.md) 接入；自定义可执行 Agent 使用桌面端的自定义 Agent 入口。完整适配器和能力矩阵见[桌面端指南](desktop/README.md)。

## 快速开始

### Apple 芯片 macOS 预览版

从[官方 V1.0.4 预发布页](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.4)下载 [`Meldwork-0.1.4-arm64.dmg`](https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.4/Meldwork-0.1.4-arm64.dmg)，将 Meldwork 移入“应用程序”，并至少安装一个受支持的本地 Agent CLI。该预发布版使用 ad-hoc 临时签名且未公证；首次启动时，macOS 可能要求你在“系统设置 -> 隐私与安全性”中选择“仍要打开 / Open Anyway”。

### 从源码运行

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

## 当前边界

Meldwork 是本地 Electron 应用，不是托管式 Agent Fleet，也不是通用 Agent 框架。当前预览版不提供远程、云端或频道 Agent 执行，不提供自动选人组队、企业 SSO/RBAC/治理或 Outcome Network。Local-first 不等于完全离线：选定的 Agent 仍可能把 Prompt、附件或 Skill（技能）发送到其自身 CLI 凭据对应的模型服务商。工作区写入是可选的工作流控制，不是操作系统级沙箱。

## 文档

- [架构与产品边界](architecture.md)
- [桌面端设置与 Agent 矩阵](desktop/README.md)
- [Agent Connector SDK](docs/agent-connector-sdk.md)
- [AI 可发现性索引](docs/ai-discoverability.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

Meldwork 采用 [Meldwork 非商用源码许可 1.0](LICENSE)。你可以出于非商业目的查看、运行、修改和分享。商业使用需要事先书面许可，详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。
