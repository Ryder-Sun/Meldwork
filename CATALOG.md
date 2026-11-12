# Meldwork General Agent catalog

[Back to README](README.md)

## General Agent catalog

### Quick installation

Settings → Agents offers installation for supported recipes on macOS and Windows. Confirm the installation before execution; npm recipes require an existing Node.js/npm installation and use fixed versions with integrity checks. The installer uses your native shell environment. Installation does not sign you in or grant knowledge access. Agents without an installation recipe, including Zcode, require manual installation.

Settings → Knowledge bases can install the official Feishu and DingTalk CLIs through npm after confirmation. Meldwork checks detection afterwards; complete sign-in and permissions with the CLI's native flow. Obsidian still uses its official download and a vault directory you select.

Meldwork detects and invokes compatible locally installed Agent commands. The catalog currently includes:

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
    <td align="center" valign="top"><img src="frontend/public/agent-logos/deepseek.png" alt="DeepSeek Harness icon" width="32" height="32"><br><strong>DeepSeek Harness</strong></td>
  </tr>
</table>

Approved Agent Connectors and custom executable Agents use the desktop connector paths. The [desktop guide](desktop/README.md) contains the current adapter, installation, provider, and capability matrix.
The [Agent Connector SDK guide](desktop/AGENT_CONNECTOR_SDK.md) explains supported packages, approval, upgrades, and conformance checks.

DeepSeek Harness (`dsh`) supports direct chats and group replies through ACP, with separate resumable sessions and workspace permissions. Its default route is ZGCI `smart-router-v2`; provide `ZGCI_API_KEY` through native credentials or the launch environment. In Settings → Agents → DeepSeek Harness, you can select an existing native `DSH_HOME` directory; detection, execution, and local Skills use that selection. The native `DSH_AGENTS_HOME` environment variable also controls the shared Skills directory. The icon comes from the official macOS application.
An explicit ACP provider or model in the native profile or DSH home patch takes precedence over this default; credential environment variables declared there are passed to DSH.

WorkBuddy also supports selecting its existing native configuration directory in Settings → Agents. Its model list, execution environment, and local and plugin Skills use the selected directory.

OpenClaw also supports selecting its native state directory in Settings → Agents. Meldwork reads the selected Agent's model configuration from that directory and runs it in its guarded local runtime.

When switching an Agent's native configuration directory, Meldwork keeps separate local conversation sessions for each selected directory and restores them when switching back. Configuration changes are blocked while a run is active or awaiting recovery.

For Zcode, choose an existing `.zcode/cli` directory containing `config.json`. Zcode runs with that directory's parent user home, which also affects its home-relative session and other file paths; project configuration may still override user configuration.

For Qwen Code, choose an existing `.qwen` directory containing settings or credentials. Qwen uses its parent user home for native sessions, Skills and other home-relative files; project and system settings retain their native precedence.

For OpenCodeReview, choose an existing `.opencodereview` directory containing `config.json`. OCR runs with that directory's parent user home, including its native session and other home-relative paths.

Hermes uses its native `config.yaml` and Provider settings. When its model, fallback model, or provider entries declare credential variables with `key_env` or `api_key_env`, Meldwork reads those variables from the launch environment or login shell for Hermes; unrelated variables and unsafe process controls are excluded. Hermes may prepare its own dependencies when started with a new native data directory.
