# Architecture

## Product Boundary

Meldwork is a local Electron desktop product for multi-agent orchestration and review with explicitly selected Skill, image, and knowledge-source context. It has no account system, tenant model, required application server, remote conversation store, email delivery, scheduled jobs, or hosted web surface. Optional Agent, Cloud, and Channel Connectors run behind the Electron main-process trust boundary and are disabled until explicitly configured. The landing page at https://ryder-mhumble.github.io/Meldwork/ is the public marketing surface for search engine and AI assistant discoverability.

The supported product surface is the packaged Electron application. The frontend is a renderer bundle; without the local preload bridge it shows a desktop-required state and cannot operate the workspace.

## Components

| Component | Responsibility | Primary evidence |
| --- | --- | --- |
| Vue renderer | Agent-first multi-session UI, direct-session rename/delete, live direct-chat conclusions and inline execution summaries, group-chat result streaming with an expandable per-Agent/right-side trace panel, per-round navigation, background completion markers, first-run carousel, conversation/Skill/image/knowledge composer UI, bounded attachment-preview cache, theme/i18n, user confirmation and input collection | `frontend/src/App.vue`, `frontend/src/components/RunTracePanel.vue`, `frontend/src/composables/useAttachmentPreviews.js`, `frontend/src/desktop.js`, `frontend/src/knowledgeBaseCatalog.js` |
| Electron preload | Exposes narrow workspace, Human Gate, Cloud control, installer/Skill, attachment, and knowledge-source methods through `window.meldworkDesktop` only to a local `file:` document; Channel ingress has no renderer API | `desktop/src/preload.cjs` |
| Electron main | Trust boundary for IPC authorization and shutdown gating, persistence, attachment import/preview, Connector registration, Skill and knowledge-source validation, local/Cloud execution, Channel receivers, navigation, sanitized run events, operating-system notifications, and installer control | `desktop/src/main.cjs` |
| Local workspace | Persists Meldwork conversations, final replies, compact evidence capsules, safe message metadata, task-scoped group Sessions, conversation-scoped direct Sessions, legacy Session migration, Agent-specific transcript deltas, Agent preferences/runtime evidence, and active run coordination | `desktop/src/workspace/local-workspace.cjs` |
| V4 orchestration | Validates frozen snapshots, phase-aware slots, typed collaboration receipts, negotiated responsibility graphs, work receipts, synthesis recovery, verification, and idempotent commits | `desktop/src/collaboration/orchestration-v4-records.cjs`, `desktop/src/workspace/local-workspace-message-submission.cjs`, `desktop/src/workspace/local-workspace-auto-runner.cjs` and its `local-workspace-auto-runner-*.cjs` parts (see Code Map) |
| Run Ledger | Atomically checkpoints bounded, sanitized per-run and per-Agent state for stop/crash recovery, marks nonterminal runs and Agent attempts interrupted after restart, supports idempotent reconciliation of missing terminal Agent messages, and purges records with their conversation | `desktop/src/runs/run-ledger.cjs` |
| Context Pack and delivery stores | Capture immutable, content-addressed Task inputs, attempt-specific approved prompts, exact outbound fingerprints, source hashes, target scope, and native Session provenance | `desktop/src/collaboration/context-pack-store.cjs`, `desktop/src/workspace/local-workspace-context-packs.cjs` |
| Outcome store | Persists typed Artifacts, Evidence, Findings, and Adoption records separately from diagnostic reasoning and tool summaries | `desktop/src/collaboration/outcome-store.cjs`, `desktop/src/collaboration/outcome-records.cjs` |
| Human Gate store | Persists permission, budget, and decision requests and their terminal user/system decisions without exposing raw request payloads to the renderer | `desktop/src/gates/human-gate-store.cjs`, `desktop/src/gates/human-gate-coordinator.cjs` |
| Scheduling and failure policy | Enforces run budgets, per-Agent controls, and one writer at a time within a conversation (conversations never wait for each other); classifies failures (sign-in, rate limit, network, provider, context overflow) and decides retries with `Retry-After`; stops a silent Agent through the invocation watchdog | `desktop/src/runs/run-scheduler.cjs`, `desktop/src/runs/failure-policy.cjs`, `desktop/src/runs/failure-signals.cjs`, `desktop/src/runs/invocation-watchdog.cjs` |
| Agent Connector registry/runtime | Validates approved manifests and instances, separates CredentialRefs, records Connector/upstream versions, and reduces versioned idempotent Run Events | `desktop/src/agents/connectors/agent-connector-manifest.cjs`, `desktop/src/agents/connectors/agent-connector-registry.cjs`, `desktop/src/agents/connectors/agent-connector-runtime.cjs` |
| Attachment store | Imports validated local images, media, documents, code/configuration files, Office files, and archives into private app-owned storage, verifies metadata/checksums on read, and removes unreferenced entries | `desktop/src/attachments/attachment-store.cjs`, `desktop/src/attachments/image-dimensions.cjs` |
| Local Skill catalog | Scans bounded known roots per Agent and returns sanitized Skill coordinates without exposing paths or contents | `desktop/src/skills/local-skill-catalog.cjs` |
| Local knowledge-source catalog | Detects and probes code-defined Feishu, DingTalk, and Obsidian access modes, returns sanitized readiness, validates task selections, and exposes reference-only future sources | `desktop/src/knowledge/local-knowledge-base.cjs` |
| Knowledge Connector runtime | Executes main-owned bounded search/fetch/snapshot/citation operations for explicit source selections; the renderer receives only sanitized discovery and selection records | `desktop/src/knowledge/local-knowledge-connectors.cjs`, `desktop/src/knowledge/knowledge-connector-filesystem.cjs` |
| Cloud Agent runtime | Persists remote job/cursor state and idempotent input, permission, cancel, callback, polling, reconciliation, and Artifact operations without requiring a server | `desktop/src/agents/cloud/cloud-agent-runtime.cjs`, `desktop/src/agents/cloud/cloud-agent-operation-store.cjs` |
| Channel ingress runtime | Verifies main-owned Connector events, rejects replay/expired delivery, maps external actors and subscriptions to local Tasks, queues a durable Inbox, and audits outbound replies | `desktop/src/channels/channel-ingress-runtime.cjs`, `desktop/src/channels/channel-inbox-store.cjs` |
| Knowledge-source store | Persists only the user-selected Obsidian Vault path; Feishu and DingTalk credentials remain owned by their local CLIs | `desktop/src/knowledge/knowledge-base-store.cjs` |
| CLI adapters | Detect and invoke supported local Agent executables with per-Agent arguments and constrained child environments | `desktop/src/agents/cli/cli-adapters.cjs` |
| Agent installer | Detects Agents and runs allowlisted npm packages or official installer scripts after user confirmation | `desktop/src/agents/installer/agent-installer.cjs` |
| Managed OpenClaw runtime | Creates isolated local configuration and a restricted tool policy for OpenClaw | `desktop/src/agents/cli/openclaw-runtime.cjs` |

## Code Map

The workspace is composed of small modules around a thin coordinator. A module either owns one piece of state or is a pure function of its inputs; each has a test file with the same name under `desktop/test/`.

**One Agent invocation** (`desktop/src/workspace/local-workspace-agent-invocation.cjs`) is the run lifecycle: lease, run, race against stop and timeout, record the result. It delegates to:

| Module | Owns |
| --- | --- |
| `invocation-session.cjs` | The native Agent session of one invocation: resume, adopt a new id, discard and rebuild, record the turn |
| `invocation-outputs.cjs` | Workspace snapshot before a writable turn, media import and artifact descriptors after it |
| `invocation-prompt.cjs` | The prompt one Agent receives (frozen, direct chat, group) |
| `invocation-budget.cjs` | Usage recorded against the run budget |
| `invocation-failure.cjs` | Why an invocation ended (stopped, timed out, interrupted, cancelled, failed) and the hidden error metadata |
| `desktop/src/runs/invocation-watchdog.cjs` | Startup, inactivity and stall windows; liveness versus substantive progress |
| `desktop/src/agents/agent-permission-policy.cjs` | Automatic answers to permission requests; a read-only turn only approves side-effect-free tools |
| `desktop/src/collaboration/collaboration-receipt.cjs` | Parsing and normalising the control receipt at the end of a turn (lenient for natural discussion, strict for phased V4) |
| `desktop/src/collaboration/answer-marker-filter.cjs` | Hides control markers while an answer streams |

**Prompts** live in `desktop/src/workspace/prompts/`: `natural-discussion-prompt.cjs` (named sections: brief, writer, owner, routing, receipt), `manual-reply-prompt.cjs` (concurrent replies in a group), and `prompt-contracts.cjs` (the language and deliverable contracts shared by all of them). Direct chats are built by `directPromptFor` in `local-workspace-context.cjs`.

**The automatic run** is `LocalWorkspaceAutoRunner`; its methods are grouped into files by what they do and assembled with `Object.assign` onto the class prototype:

| File | Responsibility |
| --- | --- |
| `local-workspace-auto-runner.cjs` | Constructor, `start` and `resume`, run-level helpers |
| `…-natural-discussion.cjs`, `…-natural-decisions.cjs` | The production path: transcript, prompts, the sequential and agent-led loops, and what happens after each round (owner takeover, ignored routes, peer blockers, missing decisions) |
| `…-v4-discussion.cjs`, `…-v4-phase.cjs`, `…-v4-results.cjs` | The phased V4 run, one phase, and turning results into receipts and commits |
| `…-v4-context.cjs`, `…-v4-delivery.cjs`, `…-v4-synthesis.cjs`, `…-v4-outcomes.cjs` | What a run freezes and shares, how context reaches each Agent, synthesis recovery, and the receipts, review issues, convergence and acceptance checks |
| `…-recovery.cjs` | Retries, pausing a failed Agent for the run, unauthorized-session recovery |
| `…-collaboration.cjs` | Collaboration records written as a run progresses |
| `…-task-graph.cjs`, `…-rounds.cjs` | V3 task-graph and V2 round runs, kept only to resume older runs |

Splitting by file did not change any method; the class still shares one `this`. New behaviour should go into a small module with its own tests and be called from the group that owns the topic, not appended to a large method.

## Reliability Rules

- Conversations are independent. A running chat, direct or group, never makes an Agent in another conversation wait, even when both use the same folder and the same Agent. The writer lease is scoped to the conversation; inside one conversation writers still take turns.
- A failure pauses an Agent for the current run only. Group membership is never rewritten because an Agent failed; a group whose members were all removed by an older build is rebuilt from the Agents that replied in it.
- Only a definitive sign-in failure marks credentials missing. A refusal that could be a proxy or a tool's own output is retried once and reported as a provider failure.
- An Agent that was available stays available through an inconclusive readiness probe for ten minutes. A definitive answer applies immediately.
- A stopped or failed turn keeps a healthy long-lived ACP process and its native session. The process is replaced only when it ignores cancellation or the protocol breaks.
- Unknown ACP traffic (banners, new update kinds, unknown notifications) is ignored; unknown requests are answered with "method not found". Malformed JSON, invalid responses and invalid permission requests still fail closed.
- Messages in a group topic carry a dispatch number (`turnSeq`) assigned before the Agent starts, so live and saved replies share one order. Failure and stop notices take the turn's number.
- A discussion does not end on a malformed receipt, an absent recipient, a peer reporting a blocker or an owner who forgot the decision: those are discarded, handed to the owner, or asked for once.

## Concurrent Collaboration V4

- A group with multiple selected Agents in `manual` mode runs as one concurrent batch. Harness freezes every selected Agent's task snapshot and delivery plan before any Scheduler lease, preserves all selected members, and publishes the batch in stable member order after the barrier. Direct conversations, one-Agent targets, and regeneration keep their existing execution paths.
- Auto Discussion begins with independent parallel proposals. The selected Agents then challenge the proposal set and negotiate one responsibility graph; every participant must agree to the same normalized plan before work begins. Harness validates and schedules that graph but does not privately assign the responsibilities.
- The agreed work packages run according to their declared dependencies and produce typed Artifact/Evidence references. Proposal, challenge, work, and verification remain read-only; when workspace writes are enabled, the agreed finalizer is the only synthesis writer. Different Agents independently verify the current candidate.
- V4 checkpoints phase, slots, attempts, receipts, delivery watermarks, negotiated roles, candidate state, and commit progress. Read-only work can recover automatically at supported boundaries; an unknown writable outcome requires a Human Gate before retry. Stop and cancellation reject late results.
- V1 manual, V2 Auto Discussion, and V3 Task Graph records remain on their legacy parsers and executors. Renderer snapshots expose only validated public phase, participant, role, progress, and Gate state, never prompts, executable paths, native Session references, or internal snapshot contents.

Automatic participant selection from a larger roster, production remote Agents, enterprise governance, and an Outcome Network are outside the V1.0.2 release boundary.

## Trust Boundaries

1. The renderer is not trusted with Node.js, Agent executable paths, native Agent session IDs or storage paths, attachment paths, Skill paths/contents, raw CLI credentials, arbitrary filesystem reads, or arbitrary process execution. User-selected conversation workdirs and the user-selected Obsidian Vault path are intentional UI-visible paths; pasted image bytes use one exact import payload.
2. Preload exposes only named IPC methods. Main validates that every request comes from the current main frame and exact bundled frontend file.
3. Main owns local files, OS dialogs, attachment validation/storage, Skill and knowledge-source discovery/revalidation, Connector approval/registration, Agent discovery, child processes, Cloud observation, Channel authentication, installer downloads, and credential encryption.
4. Agent CLIs are external processes. They receive a selected working directory, a constrained environment, permission flags, main-resolved image paths, target-scoped immutable Skill snapshots, and validated knowledge snapshots or read-only hints after capability checks.
5. Agent Connector, Cloud Connector, Channel Connector, and installer destinations are external trust boundaries. Manifests and Connector instances fail closed unless explicitly approved; Channel signatures and Workspace scope are verified before Task delivery.
6. Harness events expose only allowlisted status, conclusion deltas, reasoning summaries, plans, tool lifecycle summaries, bounded result metadata, and source message IDs. Raw chain-of-thought, commands, executable paths, native session references, credentials, unrestricted stdout/stderr, and arbitrary tool payloads remain outside the renderer and shared Agent context.

## Local Data

| Data | Location | Protection |
| --- | --- | --- |
| Meldwork conversations, messages, native session-reference mappings, Agent preferences/runtime evidence | Electron user data: `meldwork-workspace.json` | Local JSON written through main; group native references are keyed by Task and Agent, direct references by conversation and Agent, all remain main-only, and snapshots remove executable paths |
| Bounded run checkpoints | Electron user data: `meldwork-run-ledger.json` | Atomic private writes; `0600` file, with new parent directories created as `0700`; at most 64 sanitized runs with bounded Agent output/events/source IDs; no raw commands, paths, credentials, or native session references |
| Immutable Context Packs, delivery records, content blobs, typed outcomes, and Human Gates | Electron user data under `meldwork-private/` | Content-addressed or atomically written main-only records; renderer snapshots expose only bounded IDs, provenance summaries, budgets, and pending Gate choices |
| Cloud operations and Channel Inbox | Electron user data under `meldwork-private/` | Private `0600` stores keep opaque remote references, idempotency state, signed-event-derived Task data, delivery cursors, Task mappings, and outbound audit records; raw signatures, headers, credentials, and complete IM history are not exposed to the renderer |
| Imported attachments | Electron user data under `attachments/` | App-owned copy; `0700` directories, `0600` files, type/MIME/size validation, image-dimension checks where applicable, metadata checksum, ID-only renderer access |
| Knowledge-source preference | Electron user data: `meldwork-knowledge-base.json` | Stores the selected absolute Obsidian Vault path only; written atomically as a private file |
| Managed OpenClaw state/config | Electron user data under `openclaw-managed/` | Per-scope directories, mode `0700`; config mode `0600`; API key passed by child environment |
| Theme, locale, and onboarding completion | Renderer `localStorage` | Non-secret UI preferences |

Live renderer events remain transient. Main separately checkpoints a bounded sanitized run snapshot, while final replies and compact evidence capsules are stored with local conversation messages so a group result can reopen its trace without retaining raw tool output. A conclusion already emitted through answer deltas is retained in the terminal failure, timeout, stop, or interruption message. On restart, nonterminal checkpoints become `interrupted`, then every recoverable terminal Agent checkpoint that is not already represented in the conversation is materialized with its recorded status and output. Completed and partial attempts become Agent messages; failed, timed-out, stopped, and interrupted attempts become status-specific system messages. If a matching `agentRunId` message already exists but lacks its Ledger output, reconciliation enriches it once. Writable Agents are never auto-resumed. Persisted attachment references contain safe metadata only, and Skill references contain sanitized target/namespace/slug/name coordinates. Renaming a conversation preserves its native sessions; changing its working directory clears them to prevent cross-workspace resume. Deleting a Meldwork conversation must first remove its Run Ledger records, then remove its app-owned messages, native session-reference mapping, and attachments no longer referenced elsewhere. It does not call a CLI-specific deletion command or remove history stored by Codex, Hermes, or another Agent CLI.

There is no Meldwork-hosted remote data store or application account namespace. Managed OpenClaw paths are isolated by local conversation and working-directory scope inside Electron's per-user data directory. Optional Cloud jobs and Channel deliveries remain owned by their configured external systems while local recovery state stays in main-owned private stores.

## Network Surface

- Agent CLIs may call their own configured model providers.
- Selected attachments and Skill-influenced prompts may be sent by an Agent CLI to its configured model provider after local validation and capability checks.
- Feishu and DingTalk readiness probes may invoke their configured local CLIs; a selected Agent may then use those CLI connections with read-only instructions.
- An explicit Obsidian selection is searched and fetched through the main-owned read-only filesystem Connector, then captured as an immutable snapshot or explicit live reference before Agent invocation.
- Approved Agent Connectors may contact only their declared outbound destinations and receive main-owned CredentialRefs rather than renderer-provided secrets.
- Configured Cloud Connectors may submit and observe remote jobs, answer waiting input/permission, cancel idempotently, and fetch declared Artifacts.
- Configured Channel Connectors may keep a main-process receiver active while the UI window is closed; verified events become scoped Task requests and audited replies rather than copied chat history.
- The installer may download fixed Hermes/Kimi installer URLs or invoke npm for fixed package names.
- Credential-free HTTPS links may be opened in the operating-system browser; remote navigation is denied inside the Electron window.
- The renderer CSP uses `connect-src 'self'` and does not directly call model or application APIs.

## Known Risks And Assumptions

- Writable conversations that share a folder are not coordinated. Two Agents in different conversations can edit the same files at the same time, as two terminals in one directory can. Output capture compares `.meldwork-output/` before and after a run, so when two conversations produce deliverables in the same folder at the same time, one may attach or record a file the other wrote.
- Installer recipes use mutable upstream packages or scripts and currently do not verify a pinned digest or signature (`desktop/src/agents/installer/agent-installer.cjs`).
- Conversation history is local but not application-encrypted (`desktop/src/workspace/local-workspace.cjs`).
- Sanitized Run Ledger checkpoints are local and private but not application-encrypted. The store assumes one Electron main-process writer and recovers only the last persisted bounded checkpoint, not every in-memory event (`desktop/src/runs/run-ledger.cjs`).
- Conversation deletion is privacy-first across two local JSON stores rather than transactional: Ledger records are removed first; if the workspace write then fails, in-memory conversation state is rolled back and remains retryable, but the deleted trace checkpoints are not recreated.
- Imported attachment copies are private and integrity-checked but not application-encrypted (`desktop/src/attachments/attachment-store.cjs`).
- Local Skill files are untrusted prompt input. Main prevents renderer-supplied paths and cross-Agent selection, but a selected Skill can still influence Agent behavior (`desktop/src/skills/local-skill-catalog.cjs`, `desktop/src/workspace/local-workspace.cjs`).
- Obsidian selections use a main-owned read-only Connector with bounded retrieval, immutable snapshots, and citation hash verification. Generic Feishu and DingTalk access remains CLI-owned and prompt-mediated; their authentication and document permissions are not controlled by Meldwork. Notion, Confluence, Google Drive, and SharePoint are reference-only planned sources and are not active Connectors.
- Native image support is currently limited to Codex, Hermes, and OpenCode, with different per-run limits; mixed groups fail before execution when they cannot receive equal image context (`desktop/src/agents/cli/cli-adapters.cjs`).
- Read-only enforcement is owned by the Obsidian Connector for captured selections. Agent workspace and CLI-mediated remote access still depends partly on each upstream CLI honoring its permission flags; Meldwork adds per-CLI hardening where available (`desktop/src/agents/cli/cli-adapters.cjs`).
- Native Agent authentication and model requests are external dependencies; Meldwork cannot guarantee their availability or data handling.
- Agent/Cloud/Channel Connector contracts validate provenance, scope, and idempotency, but the external implementation must honor its CredentialRef, outbound destination, cancellation, and signature-verification obligations. The production build registers no Cloud or Channel Connector by default.
- macOS packaging uses ad-hoc signing for local validation, not a notarized public release (`desktop/scripts/after-pack.cjs`).

## Capability Absences

- No email sending, so there is no `emails.md`.
- No cron or scheduled background work, so there is no `cron.md`.
- No supported public or indexable routes in the app itself, so there is no `seo.md`. The landing page at https://ryder-mhumble.github.io/Meldwork/ serves as the public discoverability surface for search engines and AI assistants.

## Related Documents

- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Repository Guidelines For Agents](AGENTS.md)
- [Changelog](CHANGELOG.md)
