# Changelog

## 0.1.6 - 2026-10-17 (Meldwork-V1.0.6 prerelease)

### Agent Reliability

- Tier authentication failures instead of treating any authentication-looking diagnostic as a sign-in problem, and retry transient provider errors.
- Keep long-lived ACP Agents (Hermes, Kimi, MiMo, OpenCode) usable across stops, restarts, and hangs, including when a group alternates between read-only and write turns.
- Stop the watchdog from killing Agents that are still thinking or building, and keep an ACP turn alive through traffic this client does not recognise.
- Keep an Agent available through an inconclusive readiness probe and preserve its shell environment.
- Let MiMo and OpenCode turns that call tools finish instead of returning a partial answer, and report a CLI's own error instead of EPIPE.
- Launch WorkBuddy's app-bundled CLI again (it now ships only the lite bundle) and stop skipping every WorkBuddy permission check in write mode.
- Refuse unsafe ACP permission requests during read-only turns.
- Give direct chats the current request and the delivery contract again after a native session is rebuilt.
- Compare installed Agent CLI versions as releases, so a newer installed CLI is not offered a downgrade.
- Write workspace state compactly and durably, and record unhandled main-process faults in the diagnostics log.
- Internal: split the auto-runner and the Agent invocation into modules grouped by purpose.

### Group Conversations

- Show group replies in the order Agents were dispatched.
- Keep natural discussions going instead of ending on one slip, ask Agents to engage with each other, and let peers see workspace file paths.
- Keep group members after an Agent failure, so one proxy 403 or an expired sign-in no longer removes an Agent from later turns, and recover groups that were emptied.
- A member that is not ready no longer blocks a message to the whole group; skipped members are named.
- Deliver attachments and knowledge bases to group Agents, and send Hermes image attachments over ACP.
- Conversations no longer wait for each other, even in the same folder; writers inside one conversation still take turns.
- Import only files an Agent wrote, including paths with spaces.
- Explain run failures in Chinese and English instead of showing raw codes.

### Interface

- Start without waiting for Agent detection: the sidebar, home page, and composer show that detection is running.
- Mark conversations that wait for your decision in the sidebar and list them on the home page; mark group runs that finished while you were in another conversation.
- Add a General settings tab with language and a System, Light, or Dark appearance; System follows the operating system until you choose.
- Explain on each Agent card why an installed Agent is unavailable: its installed version, the verified range, and the failed check.
- Use a shared type scale and semantic status colors, keep secondary text within contrast guidelines, and keep long notices on screen long enough to read.
- Keep unsent text per conversation, add Skip and arrow-key navigation to first-run onboarding, ask before deleting a cloud server connection, and show Gemini CLI's own logo.

### Verification And Distribution

- Frontend 357/357, desktop 1603/1603, and deterministic evaluation 6 cases / 18 results passed on a clean checkout.
- DMG and ZIP are ad-hoc signed, without Apple Developer ID signing or notarization. No installed user application is replaced automatically.
- Live coverage is limited to observed CLI versions and configurations; this release did not repeat the live Agent acceptance run.

## 0.1.5 - 2026-09-09 (Meldwork-V1.0.5 prerelease)

### Local Agent Reliability

- Accept validated OpenClaw gateway configuration migrations without disabling path, permission, or credential isolation checks.
- Keep installed Agents visible when credential or capability checks fail; isolate failed probes and refresh the catalog after current readiness settles.
- Refresh native shell settings before manual detection and preserve supported proxy, CA, cloud Provider, and model-region settings without silently replacing a selected Provider.

### Group Conversations

- Route peer requests through explicit Agent decisions instead of interpreting prose mentions or media keywords as commands.
- Persist AI task completion separately from individual invocation success and human adoption; support single-Agent automatic work and exact visible answers.
- Resume human clarification gates after restart, reject conflicting responses, and prevent repeated responses from replaying calls.
- Serialize workspace writers, recover interrupted writes through bound approvals, retain partial results, and send acknowledged session context incrementally.
- Preserve completed and stopped task states after restart and show healthy contributions alongside failed participants.

### Verification And Distribution

- Frontend 343/343, desktop 1562/1562, and deterministic evaluation 6 cases / 18 results passed.
- Web and desktop builds, packaging, real packaged Codex/OpenClaw group execution, cancellation, and restart acceptance passed on Apple silicon macOS.
- DMG and ZIP are ad-hoc signed, without Apple Developer ID signing or notarization. No installed user application is replaced automatically.
- Live coverage is limited to observed CLI versions and configurations; cloud credential forwarding is not cloud-account certification. Full evidence: `docs/releases/Meldwork-V1.0.5.md`.

## 0.1.4 - 2026-09-01 (Meldwork-V1.0.4 prerelease)

### Natural Group Discussions

- Sequential discussion mode now runs one Agent at a time in the configured CLI order and records every round visibly.
- Auto Discussion starts with concurrent proposals, then lets Agent responses route the next turn through exact final-line `@Agent` mentions. One mention runs one Agent; multiple mentions run concurrently.
- Natural discussion prompts allow Agents to exchange views before work and review instead of forcing every turn into a review-only role.

### Session And Recovery

- Reuses one native Agent session per Agent task across discussion rounds and restarts.
- Persists round messages and checkpoints before and after Agent execution so completed turns are recovered without duplicate reruns.
- Rejects stale operation and snapshot bindings before late results can be committed.

### Verification And Distribution

- Focused natural discussion coverage: 17/17 tests passed.
- Desktop syntax checks and `git diff --check` passed.
- The Apple silicon DMG and ZIP are ad-hoc signed and not notarized. Live CLI behavior still depends on each installed Agent's version, authentication, Provider, and capabilities.

## 0.1.3 - 2026-08-18 (Meldwork-V1.0.3 prerelease)

### Concurrent Conversations

- Concurrent Responses now treats an empty explicit selection as the whole group, so users can send one message to every group Agent without adding `@` mentions first.
- Keeps every group member in the frozen batch. Agents beyond the available Scheduler capacity remain visibly queued instead of being removed from the request.
- Preserves valid visible proposals when a CLI omits or malforms its proposal receipt, while later Auto Discussion phases retain their strict structured-receipt boundary.

### Conversation Experience

- Refines user-message metadata, Agent logos, inline Agent/Skill/knowledge mentions, Markdown rendering, mention-menu tracking, and narrow-layout wrapping.
- Returns newly sent conversations to the active Agent loading state and keeps the animated return-to-bottom control for readers who have scrolled up.
- Removes the special No round limit composer background, border, shadow, and container breathing effect. The infinity status cue and real collaboration phase feedback remain available.

### Stop Durability

- Persists completed and streamed concurrent Agent replies when the user stops a batch instead of removing already visible work.
- Records stopped Agent attempts as interrupted, rejects late post-stop results, and resumes the stable batch commit idempotently after restart.

### Packaging And Verification

- Sets the frontend and desktop package version to `0.1.3` and publishes Apple silicon DMG and ZIP prerelease artifacts with a matching SHA-256 manifest.
- Frontend tests: 306/306 passed. Desktop tests: 1338/1338 passed.
- Web and Electron renderer builds, Electron `pack`, packaged acceptance, and `git diff --check` passed before release packaging.
- The prerelease remains ad-hoc signed, without Apple Developer ID signing or notarization, and may require Open Anyway on first launch.

## 0.1.2 - 2026-08-18 (Meldwork-V1.0.2 prerelease)

### Collaboration Harness V4

- Replaced the legacy group reply label with Concurrent Responses while preserving the existing `manual` persistence and IPC value.
- Freezes one shared task snapshot before Scheduler leases, keeps every selected Agent in the batch, isolates same-batch replies, and commits completed replies in stable member order.
- Starts Auto Discussion with independent parallel proposals instead of assigning the first Agent as the primary author and every later Agent as a review-only participant.
- Lets the selected Agents challenge proposals and negotiate one responsibility graph. Harness validates unanimous agreement on the normalized plan, dependencies, permissions, and participant coverage instead of privately assigning the work.
- Runs distinct agreed work packages, selects one synthesis writer, and binds independent verification to the current candidate Artifact. Contradictions remain tracked issues until resolved.
- Adds strict structured collaboration receipts, bounded Artifact/Evidence references, compact delivery watermarks, phase-and-slot operation IDs, serialized Human Gates, and idempotent crash recovery.
- Preserves V1 manual, V2 Auto Discussion, and V3 Task Graph records on their legacy parsers and executors.

### Agent Runtime

- Normalizes supported CLI output into streaming answer deltas, plans, status, tool lifecycle events, warnings, and terminal results without exposing raw commands, local paths, secrets, or chain-of-thought.
- Improves Hermes streaming and tool-event capture while preserving its read-only SQLite final-result watermark and sanitized stdout fallback.
- Improves OpenClaw stream and tool-event normalization in the Connector protocol, keeps its managed runtime state, Provider secret handling, and permission policy isolated, and closes disposable ACP sessions plus the authenticated loopback Gateway and in-flight health probes during shutdown.
- Strips collaboration control blocks from user-visible messages, live deltas, durable traces, and later Agent context; invalid or missing required receipts fail the current phase.

### Interface

- Shows real collaboration phases for parallel divergence, cross-Agent challenge and negotiation, responsibility-based work, convergence, and independent verification.
- Adds group-scoped unlimited-mode confirmation and state-driven motion with keyboard, Escape, `aria-live`, narrow-layout, and reduced-motion support.
- Adds an animated return-to-bottom control to group and direct conversation timelines.
- Keeps Agent message copy actions in the metadata row, aligns version switching, regenerate, and delete controls in the compact footer row, and hardens long-name, timestamp, and narrow-screen layout behavior.
- Keeps legacy round-zero trace labels neutral instead of relabeling historical responses as concurrent work.

### Durability And Safety

- Records V4 phases, batches, slots, attempts, frozen snapshots, dynamic roles, result references, delivery watermarks, commit state, and typed Gate state in the Run Ledger.
- Binds pending V4 Human Gates and continuations to the exact leased Agent attempt, allows safe read-only recovery, requires a Human Gate before retrying an ambiguous writable slot, rejects late results after stop, and resumes batch commits idempotently.
- Rejects terminal Agent results and V4 phase advancement while an exact permission Gate is unresolved, rejects duplicate active ACP permission request IDs, and distinguishes known checkpoint failure from unknown post-write outcomes so live recovery state cannot regress behind the durable Ledger.
- Keeps workspace writes opt-in. Concurrent replies, proposals, challenges, negotiated work, and verification remain read-only; only the synthesis writer receives write authority when enabled.
- Restricts renderer snapshots to validated phase, participant, role, progress, and Gate fields. Prompts, executable paths, native Session references, internal snapshot IDs, and unrestricted tool payloads remain main-process only.

### Packaging And Distribution

- Sets the desktop package version to `0.1.2` with permanent Bundle ID `com.rydersun.meldwork`.
- Produces Apple silicon DMG and ZIP prerelease artifacts using ad-hoc signing. This is not Apple Developer ID signing or notarization and may require Open Anyway on first launch.
- Keeps `dist:public` as the fail-closed future formal-distribution path requiring a Developer ID identity, Hardened Runtime, complete Apple notarization credentials, and post-sign validation.
- Uses the Meldwork Non-Commercial Source License; commercial use requires prior written permission.

### Verification

- Frontend tests: 302/302 passed. Desktop tests: 1335/1335 passed.
- Deterministic Eval Harness: 6 cases and 18 results passed.
- Web and Electron renderer builds, Electron `pack`, and `git diff --check` passed on the final source tree.
- Packaged Manual V4 completed with Codex, Claude, and Hermes evidence; packaged Auto Discussion V4 completed with Codex and Claude evidence; stopped runs remained stopped.
- Hermes live streaming and tool lifecycle acceptance passed. The latest OpenClaw live run failed closed with `LOCAL_AGENT_PROCESS_FAILED`; protocol fixtures and managed-runtime tests pass, but OpenClaw live streaming/tool acceptance is not claimed.
- The final 360 x 800 packaged UI acceptance passed for group and direct return-to-latest behavior, Trace layout, message actions, and stop durability. A separate Codex direct run exceeded the 300-second observation window before completing late, so it is retained as a live timing limitation rather than counted as a UI failure.
- Release DMG and ZIP digests are published in `SHA256SUMS.txt` and verified against the uploaded assets.
- The prerelease remains ad-hoc signed, without Apple Developer ID signing or notarization; `spctl` rejection remains expected.

## 0.1.0 Private Preview 1 - 2026-08-03

This private preview packages the initial Meldwork MVP for internal evaluation on Apple silicon Macs.

### Highlights

- Local-first direct conversations and persistent multi-Agent working groups.
- Automatic multi-round discussions with explicit Agent targeting and bounded execution.
- Durable, sanitized run traces for reviewing Agent activity without exposing credentials, executable paths, or private reasoning.
- Independent Provider profiles, native Agent session continuity, Skills, knowledge-source references, images, and controlled workspace access.
- Support for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, MiMo Code, Claude Code, Gemini CLI, OpenCode, Qwen Code, OpenCodeReview, and Custom Agents.
- Major frontend and Electron modularization while preserving the existing UI and public desktop bridge contracts.

### Distribution

- macOS Apple silicon: DMG and ZIP artifacts.
- Private preview only. The application was ad-hoc signed and not notarized with an Apple Developer ID.
- Windows and Intel Mac release artifacts were not included.

### License

Meldwork was source-available under PolyForm Noncommercial 1.0.0 for this historical preview. Commercial use required a separate written agreement.

### Verification

- Frontend tests: 217 passed.
- Desktop tests: 470 passed.
- Web and Electron frontend builds passed.
- Electron packaging, ASAR inspection, and deep signature verification passed.
