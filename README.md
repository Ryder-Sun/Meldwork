<!-- <p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logos/meldwork-wordmark-v3-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="frontend/public/logos/meldwork-wordmark-v3.svg">
    <img src="frontend/public/logos/meldwork-wordmark-v3.svg" alt="Meldwork" width="360">
  </picture>
</p> -->

<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork README banner" width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Meldwork — Local-first multi-agent orchestration for AI coding agents

**Coordinate Codex, Claude Code, Gemini CLI, and 9 more agent CLIs from one desktop workspace. Stop manually copying context between terminals — Meldwork freezes one task snapshot, sends it to every selected agent, captures their independent findings as evidence, and gates workspace writes behind your approval.**

Meldwork is a local-first multi-agent orchestration desktop app for macOS (Apple silicon). It connects the AI coding agent CLIs you already have installed — Codex, Claude Code, Hermes, OpenCode, Gemini CLI, Qwen Code, Kimi Code, MiMo Code, Pi Agent, OpenClaw, OpenCodeReview, and WorkBuddy — into one reviewable workspace where you can run Direct sessions, Concurrent Responses (same task, multiple agents, independent replies), or Auto Discussion V4 (agents propose, challenge, negotiate responsibilities, and verify results across rounds).

Unlike terminal multiplexers (tmux, zellij) that show raw output side by side, Meldwork preserves every finding as structured evidence (Finding → Evidence → Decision → Disposition), keeps a human adoption gate before any file changes, and makes multi-agent work inspectable and reusable across sessions.

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.4/Meldwork-0.1.4-arm64.dmg"><strong>Download Meldwork V1.0.4 for Apple silicon macOS</strong></a>
  · <a href="architecture.md">Architecture</a>
  · <a href="LICENSE">License</a>
</p>

## Who it is for

Use Meldwork when you:

- run multiple AI coding agents (Codex, Claude Code, Gemini CLI, Hermes, OpenCode, etc.) and want to coordinate them without manually passing context between terminals;
- need independent review for code, research, or product analysis before choosing a path;
- want to compare multiple agents' responses to the same task side by side, with evidence trails and a human approval gate before any workspace writes;
- need inspectable traces, evidence, and human review for multi-agent coding sessions — so you can resume, audit, and reuse work across sessions.

## Workflow

1. **Select** the local Agents and participants.
2. **Scope** the goal, working directory, context, and permissions.
3. **Run** Direct, Concurrent Responses, or Auto Discussion V4.
4. **Review and adopt** the result, evidence, and any Human Gate before changing the workspace.

## Collaboration modes

| Mode | What happens | Best for |
| --- | --- | --- |
| **Direct** | One selected Agent keeps its conversation and native session when supported. | Focused work with one Agent. |
| **Concurrent Responses** | Selected Agents receive the same frozen task snapshot and return independent replies in stable order. | Comparing approaches before choosing one. |
| **Auto Discussion V4** | The first round runs concurrent proposals. Later turns follow the discussion: one Agent can route the next turn with `@Agent`, or several Agents can be selected for a concurrent response. Native Agent sessions continue across rounds. | Multi-round work that benefits from discussion, flexible routing, and review. |

Participants are always selected by the user. Automatic selection from a larger roster is outside the current preview.

## How Meldwork differs

Meldwork is a local-first multi-agent orchestration desktop app — not a terminal multiplexer, cloud agent fleet, communication network, or programmable orchestration framework. It connects the local Agent CLIs you already use to a decision-ready review workflow and keeps independent findings, evidence, responsibility, and the human adoption decision visible in one local workspace.

If you're comparing Meldwork to other multi-agent orchestration tools, here's where it fits:

| Tool | What it does | What Meldwork adds |
| --- | --- | --- |
| tmux / zellij | Terminal multiplexer — run agents in panes, manually copy context between them | Frozen task snapshots, evidence trails, human adoption gate, no manual context passing |
| Claude Code Agent Teams | Native subagent spawning within Claude Code only | Cross-CLI: mix Codex, Claude Code, Hermes, OpenCode and 8 more in one workspace |
| Claude Squad / amux / Conductor | Parallel agent runners with git worktree isolation | Evidence-backed review (Finding → Evidence → Decision → Disposition), not just parallel execution |
| CrewAI / AutoGen / LangGraph | Programmable multi-agent frameworks you build yourself | Ready-to-use desktop workflow — no orchestration code to write |
| Conductor (conductor.build) | macOS desktop for parallel Claude Code + Codex | Heterogeneous CLI support (12+ agents), evidence trails, human gate before writes |
| Emdash | Electron desktop for 22+ CLI agents | Decision traceability, evidence-aware runs, structured adoption records |
| Bernstein | Deterministic orchestrator with pre-merge verification | Human-in-the-loop adoption gate, not just automated CI checks |
| Buzz / Pragma / Paperclip | Agent communication / workflow / org management | Case-scoped independent judgments with evidence-backed decisions, not identity or org charts |
| Warp Oz / Devin / Factory / OpenHands Cloud | Cloud-hosted agent execution platforms | Runs locally in your Electron work cell with existing CLIs — no cloud dependency |

## See it in action

<table>
  <tr>
    <th>Local Agent discovery</th>
    <th>Multi-agent review</th>
    <th>Direct multimodal work</th>
  </tr>
  <tr>
    <td align="center"><a href="assets/meldwork-agent-discovery.png"><img src="assets/meldwork-agent-discovery.png" alt="Meldwork local-first multi-agent workspace detecting Agent CLIs" width="320" height="205"></a></td>
    <td align="center"><a href="assets/meldwork-multi-agent-review.png"><img src="assets/meldwork-multi-agent-review.png" alt="Meldwork multi-agent collaboration with evidence and human review" width="320" height="205"></a></td>
    <td align="center"><a href="assets/meldwork-direct-multimodal.png"><img src="assets/meldwork-direct-multimodal.png" alt="Meldwork direct Agent workspace with local files and media" width="320" height="205"></a></td>
  </tr>
</table>

Example: give Codex, Claude Code, and Gemini CLI the same task — review a PR, analyze a bug, or compare implementation approaches. Meldwork freezes the task context, sends it to all three agents simultaneously, captures their independent findings as evidence, and lets you adopt only the result you approve. No manual context copying between terminals.

## Supported local Agent CLIs

Meldwork detects and invokes an installed command when its adapter and the CLI version are compatible:

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

Approved Agent Connectors can be added through the [Agent Connector SDK](docs/agent-connector-sdk.md); custom executable Agents use the desktop custom-Agent path. See the [desktop guide](desktop/README.md) for the full adapter and capability matrix.

## Quick start

### Apple silicon macOS preview

Download [`Meldwork-0.1.4-arm64.dmg`](https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.4/Meldwork-0.1.4-arm64.dmg) from the [official V1.0.4 prerelease](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.4), move Meldwork to Applications, and install at least one supported local Agent CLI. The prerelease is ad-hoc signed and not notarized; macOS may require **Open Anyway** in **System Settings -> Privacy & Security** on first launch.

### Run from source

Prerequisites: Node.js `22.12+` and npm.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

Before distributing a build:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

## Current boundary

Meldwork is a local Electron desktop app for multi-agent orchestration and review — not a hosted agent fleet or a general agent framework. The current preview does not provide remote/cloud agent execution, automatic participant selection, enterprise SSO/RBAC/governance, or an Outcome Network. Local-first does not mean fully offline: a selected Agent may send prompts, attachments, or Skills to its own CLI credentials' model provider. Workspace writes are opt-in workflow controls, not an operating-system sandbox.

## Docs

- [Architecture and product boundary](architecture.md)
- [Desktop setup and Agent matrix](desktop/README.md)
- [Agent Connector SDK](docs/agent-connector-sdk.md)
- [AI discoverability index](docs/ai-discoverability.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Meldwork is source-available under the [Meldwork Non-Commercial Source License 1.0](LICENSE). You may inspect, run, modify, and share it for non-commercial purposes. Commercial use requires prior written permission; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md).
