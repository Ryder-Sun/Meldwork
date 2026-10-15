<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-cn.png" alt="Meldwork README banner" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Meldwork：本地优先的 General Agent 工作空间

**把多个 General Agent 组织成一个可复核的工作小组。Meldwork 为每个任务建立共享上下文，让选定的 Agent 独立调查或分轮讨论，并在采用结果前保留完整的证据和人工决策。**

Meldwork 是一个本地优先的 Electron 工作空间，用来连接你已经在电脑上使用的 Agent 工具。它支持直接会话、独立并发回复，以及包含提案、质询、职责协商、分工执行、整合和复核的 Auto Discussion V4。Agent 可以处理文字、文件、图片、音视频、Skill 和选定的知识源，因此同一个工作空间可以覆盖研究、分析、写作、规划、评审和实施。

产品围绕一条可持续复核的记录组织工作：**Case → Finding → Evidence → Decision → Disposition**。Meldwork 将任务快照、Agent 贡献、运行状态、产物、人工审批门和采用决定保存在同一个本地工作单元中。工作区写入默认受控，并由用户明确授权。

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.5/Meldwork-0.1.5-arm64.dmg"><strong>下载 Meldwork V1.0.5 Apple 芯片 macOS 版</strong></a>
  · <a href="architecture.md">架构</a>
  · <a href="LICENSE">许可证</a>
</p>

## Meldwork 适合什么工作

当一个决定需要多个视角，并且需要留下清晰的采用依据时，Meldwork 更适合：

- 研究与信息综合：结合本地 Agent 工具和明确选择的知识源；
- 产品、市场、运营和技术分析；
- 写作、规划、评审和结构化文档工作；
- 处理本地文档、图片、音频、视频、PDF、代码和配置文件的多模态工作；
- 需要保留发现、证据、权限、运行轨迹和最终采用决定的实施工作。

## 一个任务如何在 Meldwork 中推进

1. **选择**本 Case 的 Agent 和参与者。
2. **限定**目标、工作目录、上下文、附件、Skill、知识源和权限。
3. **运行**直接会话、并发回复或 Auto Discussion V4。
4. **复核**发现、证据、产物、运行轨迹和人工审批门。
5. **采用**批准的结果，或保留为待解决状态继续处理。

## 协作模式

| 模式 | 运行方式 | 适合场景 |
| --- | --- | --- |
| **直接会话** | 一个已选 Agent 在适配器支持时保持对话和原生会话。 | 聚焦研究、写作、分析或执行。 |
| **并发回复** | 已选 Agent 收到同一份冻结任务快照，并按稳定顺序返回独立回复。 | 在选择方案前比较不同视角。 |
| **Auto Discussion V4** | Agent 先提出方案，再进行质询、职责协商、分工执行、候选结果整合和独立复核；支持时会在多轮中保持原生会话。 | 需要讨论、分工和复核的多步骤工作。 |

参与者始终由用户选择。从更大候选池自动选人组队不属于当前预览版。

## 复核记录

Meldwork 将协作组织成一套决策过程，而不是一串聊天消息：

- **Case**：定义问题、范围、上下文和权限；
- **Finding**：记录 Agent 的判断、观察或行动建议；
- **Evidence**：将 Finding 连接到回复、产物、文件、知识结果或其他受约束的依据；
- **Decision**：记录证据支持的结论、未决问题和选定路径；
- **Disposition**：记录结果已接受、修订、拒绝、被替代或仍未解决。

Run Ledger 会保留阶段、参与者、尝试、回执、产物、恢复状态和人工审批门。诊断工具输出与敏感运行信息留在 Electron 主进程边界内。

## General Agent 目录

当适配器和 CLI 版本兼容时，Meldwork 会检测并调用已安装的 Agent 命令。当前目录包括：

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

已批准的 Agent Connector 和自定义可执行 Agent 使用桌面端的连接器入口。完整的适配器、安装、Provider 和能力矩阵见[桌面端指南](desktop/README.md)。

## 上下文与本地边界

Meldwork 作为本地 Electron 应用运行。对话、群组配置、运行记录和应用管理的附件保存在本地用户数据目录。渲染进程只通过受约束的 preload API 获取校验后的状态；可执行路径、凭据、原生会话引用、Skill 路径和任意 Shell 权限都留在主进程中。

选定的 Agent 仍可能把 Prompt、附件或 Skill 发送到其自身 CLI 凭据对应的模型服务商。知识访问必须明确选择并受边界约束：当前实现支持本地 Obsidian 检索，以及由本地 CLI 管理的飞书或钉钉访问模式。Local-first 描述的是 Meldwork 的数据和协作位置，不代表 Agent 使用的模型服务商一定离线。

## 下载 V1.0.5

Apple 芯片 macOS 用户请前往 [Meldwork V1.0.5 预发布页](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.5)，下载 [`Meldwork-0.1.5-arm64.dmg`](https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.5/Meldwork-0.1.5-arm64.dmg)。发布页同时提供 ZIP 压缩包和 SHA-256 校验文件。启动应用前，请至少安装一个受支持的本地 Agent CLI。

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

## V1.0.5

V1.0.5 改进了本地 Agent 的就绪检测与恢复，在单个 Agent 失败时保留健康参与者，重启后继续显示已完成和已停止的工作，并加强了群组执行与结果导入。同时更新了工作区偏好、侧栏和标题栏细节，以及 Pi 能力探测契约。

本预览版已完成 343/343 前端测试、1,562/1,562 桌面端测试、6 个确定性评估场景共 18 条结果验证，并通过 Web 与桌面构建、打包、ZIP 完整性、深度代码签名校验，以及 Apple 芯片 macOS 上的群组执行、取消和重启恢复验收。安装包仍为 ad-hoc 临时签名且未公证；实际运行结果仍取决于本机 Agent CLI 版本、鉴权、Provider 和能力。

## 文档

- [架构与产品边界](architecture.md)
- [桌面端设置与 Agent 矩阵](desktop/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

Meldwork 采用 [Meldwork 非商用源码许可 1.0](LICENSE)。你可以出于非商业目的查看、运行、修改和分享。商业使用需要事先书面许可，详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。
