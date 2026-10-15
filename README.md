<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork README banner" width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Meldwork — A local-first workspace for General Agents

**Turn several General Agents into a reviewable working group. Meldwork gives every task a shared context, lets selected Agents investigate independently or discuss across rounds, and keeps the evidence and human decision visible before anything is adopted.**

Meldwork is a local-first Electron workspace for using the Agent tools you already have on your Mac. It supports focused conversations, independent concurrent responses, and Auto Discussion V4 for proposal, challenge, negotiated work, synthesis, and verification. Agents can work with text, files, images, media, Skills, and selected knowledge sources, so the same workspace can support research, analysis, writing, planning, review, and implementation.

The product is organized around a durable review record: **Case → Finding → Evidence → Decision → Disposition**. Meldwork keeps the task snapshot, Agent contributions, run state, artifacts, Human Gates, and adoption decision together in one local work cell. Workspace writes are opt-in and remain under the user's control.

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.5/Meldwork-0.1.5-arm64.dmg"><strong>Download Meldwork V1.0.5 for Apple silicon macOS</strong></a>
  · <a href="architecture.md">Architecture</a>
  · <a href="LICENSE">License</a>
</p>

## What Meldwork is for

Meldwork is useful when a decision benefits from more than one perspective and a clear record of why a result was adopted. Typical work includes:

- research and information synthesis across local Agent tools and selected knowledge sources;
- product, market, operational, and technical analysis;
- writing, planning, review, and structured document work;
- multimodal work with local documents, images, audio, video, PDFs, and code or configuration files;
- implementation and review tasks where findings, evidence, permissions, and the final adoption decision should remain inspectable.

## How a task moves through Meldwork

1. **Select** the Agents and participants for this Case.
2. **Scope** the goal, working directory, context, attachments, Skills, knowledge sources, and permissions.
3. **Run** a direct conversation, Concurrent Responses, or Auto Discussion V4.
4. **Review** the findings, evidence, artifacts, trace, and any Human Gate.
5. **Adopt** the approved result or leave the Case unresolved for further work.

## Collaboration modes

| Mode | What happens | Best for |
| --- | --- | --- |
| **Direct** | One selected Agent keeps its conversation and native session when supported. | Focused research, writing, analysis, or execution. |
| **Concurrent Responses** | Selected Agents receive the same frozen task snapshot and return independent responses in stable order. | Comparing perspectives before choosing a path. |
| **Auto Discussion V4** | Agents propose, challenge, negotiate responsibilities, execute agreed work, synthesize a candidate result, and verify it across bounded rounds. Native Agent sessions continue when supported. | Multi-step work that needs discussion, division of responsibility, and review. |

Participants are selected by the user. Automatic selection from a larger roster is outside the current preview.

## The review record

Meldwork treats collaboration as a decision process rather than a stream of chat messages:

- **Case** defines the question, scope, context, and permissions.
- **Finding** records an Agent's claim, observation, or proposed action.
- **Evidence** links the finding to a response, artifact, file, knowledge result, or other bounded reference.
- **Decision** records what the evidence supports, what remains uncertain, and which path is selected.
- **Disposition** records whether the result was accepted, revised, rejected, superseded, or left unresolved.

The Run Ledger preserves phase, participant, attempt, receipt, artifact, recovery, and Human Gate state. Diagnostic tool output and sensitive runtime details stay behind the Electron main-process boundary.

## General Agent catalog

Meldwork detects and invokes compatible locally installed Agent commands. The catalog currently includes:

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

Approved Agent Connectors and custom executable Agents use the desktop connector paths. The [desktop guide](desktop/README.md) contains the current adapter, installation, provider, and capability matrix.

## Context and local boundaries

Meldwork runs as a local Electron application. Conversations, group configuration, run records, and app-owned attachments stay in the local user data directory. The renderer receives only validated snapshots through a narrow preload API; executable paths, credentials, native session references, Skill paths, and unrestricted shell access remain in the main process.

Selected Agents may send prompts, attachments, or Skills to the model provider configured in their own CLI. Knowledge access is explicit and bounded: the current implementation supports local Obsidian retrieval and CLI-owned Feishu or DingTalk access modes. Local-first describes where Meldwork stores and coordinates work; it does not promise that an Agent's model provider is offline.

## Download V1.0.5

For Apple silicon macOS, download the [Meldwork V1.0.5 prerelease](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.5) and choose [`Meldwork-0.1.5-arm64.dmg`](https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.5/Meldwork-0.1.5-arm64.dmg). The release also includes a ZIP archive and SHA-256 manifest. Install at least one supported local Agent CLI before opening the app.

The preview artifacts are ad-hoc signed and not notarized with an Apple Developer ID. macOS may require **Open Anyway** under **System Settings → Privacy & Security** on first launch.

## Run from source

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

## V1.0.5

V1.0.5 improves local Agent readiness and recovery, preserves healthy participants when another Agent fails, keeps completed and stopped work visible after restart, and tightens group execution and output handling. It also updates the workspace preference flow, sidebar and titlebar details, and the Pi capability probe contract.

Verification for this prerelease includes 343/343 frontend tests, 1,562/1,562 desktop tests, six deterministic evaluation cases with 18 results, web and desktop builds, packaging, ZIP integrity, deep code-signature verification, and packaged macOS acceptance for group execution, cancellation, and restart recovery. The artifacts remain ad-hoc signed and unnotarized; live behavior still depends on the installed Agent CLI version, authentication, Provider, and capabilities.

## Documentation

- [Architecture and product boundary](architecture.md)
- [Desktop setup and Agent matrix](desktop/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Meldwork is source-available under the [Meldwork Non-Commercial Source License 1.0](LICENSE). You may inspect, run, modify, and share it for non-commercial purposes. Commercial use requires prior written permission; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md).
