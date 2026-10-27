<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-cn.png" alt="Meldwork README banner" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Meldwork：让 Agent 自主协作推进任务

**提出目标，让 Agent 们协作完成。Meldwork 把你已有的 Agent 组织成一个工作小组，共享上下文、讨论方案、协作执行并相互检查，减少你在它们之间转述、催办和整合结果的工作。**

Meldwork 是一个本地优先的多 Agent 协作工作空间，用来连接你已经在电脑上使用的 Agent 工具。你选定参与者、目标、上下文和权限后，自动讨论中的 Agent 可以接续彼此的工作，请求同伴补充或检查，并在授权范围内推进任务。它也支持单个 Agent 的直接会话和多个 Agent 的独立并发回复，覆盖研究、分析、写作、规划、评审和实施。

你无需安排每一轮发言，但仍负责目标、权限和关键决策。遇到信息缺失、权限请求或需要取舍的问题时，任务可能等待你处理。工作区写入需要明确授权；协作过程、运行状态和产物保存在本地，方便回看和继续工作。

<p align="center">
  <a href="https://github.com/Ryder-Sun/Meldwork/releases/download/Meldwork-V1.0.7/Meldwork-1.0.7-arm64.dmg"><strong>下载 Meldwork V1.0.7 Apple 芯片 macOS 版</strong></a>
  · <a href="architecture.md">架构</a>
  · <a href="LICENSE">许可证</a>
</p>

## Meldwork 适合什么工作

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

## General Agent 目录

当适配器和 CLI 版本兼容时，Meldwork 会检测并调用已安装的 Agent 命令。当前目录包括：

<table>
  <tr>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/codex.svg" alt="Codex logo" width="32" height="32"><br><strong>Codex</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/hermes.png" alt="Hermes logo" width="32" height="32"><br><strong>Hermes</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/openclaw-transparent.png" alt="OpenClaw logo" width="32" height="32"><br><strong>OpenClaw</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/workbuddy.png" alt="WorkBuddy logo" width="32" height="32"><br><strong>WorkBuddy</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/zcode.png" alt="Zcode logo" width="32" height="32"><br><strong>Zcode</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/pi.svg" alt="Pi Agent logo" width="32" height="32"><br><strong>Pi Agent</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/kimi.png" alt="Kimi Code logo" width="32" height="32"><br><strong>Kimi Code</strong></td>
  </tr>
  <tr>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/mimo.svg" alt="MiMo Code logo" width="32" height="32"><br><strong>MiMo Code</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/claude.png" alt="Claude Code logo" width="32" height="32"><br><strong>Claude Code</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/gemini.svg" alt="Gemini CLI logo" width="32" height="32"><br><strong>Gemini CLI</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/opencode.svg" alt="OpenCode logo" width="32" height="32"><br><strong>OpenCode</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/qwen.svg" alt="Qwen Code logo" width="32" height="32"><br><strong>Qwen Code</strong></td>
    <td align="center" valign="top"><img src="frontend/public/agent-logos/opencodereview.svg" alt="OpenCodeReview logo" width="32" height="32"><br><strong>OpenCodeReview</strong></td>
  </tr>
</table>

已批准的 Agent Connector 和自定义可执行 Agent 使用桌面端的连接器入口。完整的适配器、安装、Provider 和能力矩阵见[桌面端指南](desktop/README.md)。

## 上下文与本地边界

Meldwork 作为本地 Electron 应用运行。对话、群组配置、运行记录和应用管理的附件保存在本地用户数据目录。渲染进程只通过受约束的 preload API 获取校验后的状态；可执行路径、凭据、原生会话引用、Skill 路径和任意 Shell 权限都留在主进程中。

选定的 Agent 仍可能把 Prompt、附件或 Skill 发送到其自身 CLI 凭据对应的模型服务商。知识访问必须明确选择并受边界约束：当前实现支持本地 Obsidian 检索，以及由本地 CLI 管理的飞书或钉钉访问模式。Local-first 描述的是 Meldwork 的数据和协作位置，不代表 Agent 使用的模型服务商一定离线。

## 下载 V1.0.7

Apple 芯片 macOS 用户请前往 [Meldwork V1.0.7 预发布页](https://github.com/Ryder-Sun/Meldwork/releases/tag/Meldwork-V1.0.7)，下载 [`Meldwork-1.0.7-arm64.dmg`](https://github.com/Ryder-Sun/Meldwork/releases/download/Meldwork-V1.0.7/Meldwork-1.0.7-arm64.dmg)。发布页同时提供 ZIP 压缩包和 SHA-256 校验文件。启动应用前，请至少安装一个受支持的本地 Agent CLI。

该预览版安装包使用 ad-hoc 临时签名，未使用 Apple Developer ID 签名，也未进行公证。macOS 首次启动时可能需要在“系统设置 → 隐私与安全性”中选择“仍要打开 / Open Anyway”。

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

## V1.0.7

V1.0.7 修复自动讨论中断后流式回复丢失，适配 Hermes 原生流式输出与 ACP 会话边界，并避免 MiMo 无界面运行卡在交互式计划提示。新增 Zcode，使用官方标志、排列在 Pi Agent 前并沿用原生默认配置；WorkBuddy 可以复用在 Meldwork 中选定的桌面已配置模型。

Electron 验收覆盖模拟适配器下六 Agent 无限轮讨论、中断和重载后内容保留，以及真实 WorkBuddy 回复。CLI 与界面回归测试覆盖输出解析、取消、认证报错和脱敏。真实执行仍取决于 CLI 与服务商：Zcode 默认服务商需要有效 API Key，OpenCode 路由返回错误 `tool_calls` 结束原因的问题仍需上游修复。无限轮讨论不会关闭进程停滞检测。

## 文档

- [架构与产品边界](architecture.md)
- [桌面端设置与 Agent 矩阵](desktop/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

Meldwork 以 [Apache License 2.0](LICENSE) 开源。在许可证条款范围内，可以商用、私用、修改和再分发。商用无需另行授权或支付许可费。Apache-2.0 不授予商标权；详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。
