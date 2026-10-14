# Verification And Test Coverage

Current verification is V1.0.5 / package 0.1.5 on 2026-09-09 for Apple silicon macOS. Repository tooling and CI require Node.js 22.12 or newer; the packaged desktop uses Electron's bundled runtime.

## V1.0.5 Results

- `npm --prefix frontend test`: 343/343 across 37 files.
- `MELDWORK_TEST_CLAUDE_EXECUTABLE=... npm --prefix desktop test`: 1562/1562, no skips.
- `npm --prefix desktop run eval:deterministic`: 6 cases, 18 results.
- Web build, desktop renderer build, `pack`, and `dist` passed.
- DMG/ZIP integrity and strict ad-hoc signature verification passed; 116 packaged source/JSON files matched the working tree.
- Actual packaged Codex/OpenClaw group execution, active-task cancellation, repeated detection, and restart without replay passed in an isolated profile.
- Development Electron acceptance additionally covers bound human input recovery, exact answers, and injected peer failure with a real healthy Codex participant.

See [V1.0.5 release evidence](releases/Meldwork-V1.0.5.md) and [detailed progress](releases/Meldwork-V1.0.5-progress.md) for limitations and actual commands. These results do not certify every supported CLI, cloud account, or operating system.

## V1.0.3 Historical Baseline

All evidence below retains its original 2026-08-18 scope; it is not the current V1.0.5 result.

The candidate is ad-hoc signed, not signed with an Apple Developer ID, and not notarized. Passing `codesign` proves bundle integrity only. Gatekeeper acceptance is not claimed, and `spctl` rejection is expected for this candidate.

## Executed Verification

| Check | Evidence | Result |
| --- | --- | --- |
| Frontend unit suite | `npm --prefix frontend test` | 306/306 tests passed |
| Desktop unit suite | `npm --prefix desktop test` | 1338/1338 tests passed |
| Deterministic Eval Harness | `npm --prefix desktop run eval:deterministic` | 6 cases and 18 results passed |
| Renderer builds | `npm --prefix frontend run build` and `npm --prefix frontend run build:desktop` | Both builds passed |
| Packaged application directory | `npm --prefix desktop run pack` | Passed on the final source tree |
| Prerelease archives | `npm --prefix desktop run dist` | Apple silicon DMG and ZIP generated from the final source tree |
| Archive integrity | `hdiutil verify`, `unzip -t`, and `shasum -a 256 -c desktop/dist/SHA256SUMS.txt` | DMG, ZIP, and checksum manifest passed local verification |
| Ad-hoc signature integrity | `codesign --verify --deep --strict --verbose=2 desktop/dist/mac-arm64/Meldwork.app` | Passed on the final packaged app |
| Gatekeeper assessment | `spctl --assess --type execute --verbose=4 desktop/dist/mac-arm64/Meldwork.app` | Rejection is expected without Developer ID signing and notarization |
| Whitespace validation | `git diff --check` | Passed |

## Packaged-App Acceptance

Packaged checks combine current V1.0.3 UI acceptance with retained V1.0.2 live Agent evidence for unchanged runtime paths. The V1.0.3 checks used an isolated user-data profile and isolated workspace to validate implicit group targeting and unlimited-mode styling. Live Agent evidence validates only the observed local versions and authentication state, not every supported installation.

| Surface | Result | Boundary |
| --- | --- | --- |
| Hermes direct execution | Streaming answer deltas and a closed tool lifecycle | Passed |
| OpenClaw direct execution | Latest live run failed during proposal with `LOCAL_AGENT_PROCESS_FAILED` | Failed closed; protocol fixtures and managed-runtime tests pass, but live streaming/tool lifecycle is not certified |
| Manual V4 | Selected Agents use one frozen snapshot; results commit in stable member order | Completed packaged runs with Codex, Claude, and Hermes evidence |
| Implicit group targeting | Concurrent Responses with no explicit `@` or Agent selection resolves to every Agent in the group | Passed; four Agents ran and the fifth remained visibly queued under Scheduler capacity |
| Auto Discussion V4 | Parallel proposals, cross-Agent negotiation, agreed work packages, synthesis, and independent verification | Completed packaged runs with Codex and Claude evidence |
| Stop behavior | Stop after the first answer delta, then compare Ledger, message, and workspace hashes after 10.25 seconds | Passed; the run remained `stopped` and all hashes were unchanged |
| No round limit composer | Compare the finite and unlimited composer surface while retaining the infinity cue | Passed; background, shadow, and border remained identical |
| Narrow-layout return control | Group and direct conversation return-to-latest behavior at 360 x 800 | Passed; both surfaces exposed one button while reading above, returned to the bottom, and removed the button after activation |
| Narrow-layout details and actions | Trace panel geometry plus copy, regenerate, version, and delete placement at 360 x 800 | Passed without control overlap |

A Codex direct acceptance run produced no answer delta inside the 300-second observation window and completed only after the helper timed out. The final UI acceptance therefore used Claude for the direct surface while keeping Claude and Codex in the group. This timing result is not evidence of a renderer regression, but it remains a live-runtime limitation. These checks do not certify every supported Agent, installer recipe, upstream CLI version, authentication state, or operating system.

## Concurrent Collaboration V4 Coverage

| Use case / rule | Expected behavior | Evidence |
| --- | --- | --- |
| Strict V4 records and legacy compatibility | Strictly validates V4 phases, slots, frozen snapshots, stable operation IDs, delivery watermarks, commit state, and Human Gates while preserving V1 manual, V2 Auto Discussion, and V3 Task Graph parsing | `desktop/test/collaboration/orchestration-v4-records.test.cjs`; `desktop/test/runs/run-ledger.test.cjs` |
| Concurrent response batch isolation | Freezes one shared snapshot before Scheduler leases, retains every selected Agent, prevents same-batch visibility, and commits out-of-order results in stable member order | `desktop/test/workspace/local-workspace-v4-manual-durability.test.cjs`; `desktop/test/workspace/local-workspace-harness.test.cjs`; `desktop/test/runs/run-scheduler.test.cjs` |
| Independent proposals and Agent negotiation | Starts all selected Agents from the same task snapshot, gathers independent proposals, requires cross-Agent discussion, and accepts work only after all participants agree to the same normalized responsibility plan | `desktop/test/workspace/local-workspace-v4-agent-negotiation.test.cjs`; `desktop/test/workspace/local-workspace-auto.test.cjs` |
| Responsibility-based work | Schedules the agreed work packages with dependency and permission boundaries instead of assigning every non-first Agent a permanent review-only role | `desktop/test/workspace/local-workspace-v4-agent-negotiation.test.cjs`; `desktop/test/workspace/local-workspace-v4-auto-durability.test.cjs` |
| Structured receipts and context budget | Validates proposal, challenge, work, synthesis, and verification receipts; strips control blocks from visible output; rejects malformed receipts; keeps bounded collaboration delivery and incremental watermarks | `desktop/test/workspace/local-workspace-v4-receipt.test.cjs`; `desktop/test/workspace/local-workspace-context-packs.test.cjs` |
| Synthesis, findings, and convergence | Gives workspace write authority to one synthesis Agent, binds verification to the current Artifact, tracks contradictory `ReviewerFinding` records as unresolved issues, and completes only after independent support | `desktop/test/workspace/local-workspace-v4-convergence.test.cjs`; `desktop/test/collaboration/collaboration-records.test.cjs` |
| Crash recovery, exact-attempt Gate binding, and idempotent commit | Binds pending V4 Gates and continuations to exactly one leased Agent attempt, recovers safe read-only slots, prevents ambiguous writable retries without a Human Gate, rejects late results after stop, and resumes batch commit idempotently | `desktop/test/workspace/local-workspace-v4-auto-durability.test.cjs`; `desktop/test/workspace/local-workspace-v4-manual-durability.test.cjs`; `desktop/test/workspace/local-workspace-human-gate-recovery.test.cjs`; `desktop/test/workspace/local-workspace-v4-gate-renderer-bridge.test.cjs` |
| Gate serialization and terminal ordering | Stops dispatching new slots after the first parallel Gate, lets already-running read-only work settle, rejects terminal results while permission callbacks remain unresolved, rejects duplicate active ACP permission IDs, and preserves monotonic recovery across known failures and unknown post-write outcomes | `desktop/test/workspace/local-workspace-v4-gate-pause.test.cjs`; `desktop/test/workspace/local-workspace-v4-auto-durability.test.cjs`; `desktop/test/workspace/local-workspace-human-gate-recovery.test.cjs`; `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs`; `desktop/test/gates/human-gate-coordinator.test.cjs` |
| Unlimited-mode and trace UI | Shows validated phase, participant, role, slot, and Gate state; scopes unlimited confirmation to one group; supports reduced motion; preserves neutral labels for legacy round-zero traces | `frontend/src/__tests__/meldwork/App.unlimited-review.spec.js`; `frontend/src/__tests__/meldwork/App.run-trace.spec.js`; `frontend/src/__tests__/meldwork/App.conversation-trace.spec.js` |

## Runtime And Product Coverage

| Area | Covered behavior | Evidence |
| --- | --- | --- |
| Agent stream and tool-event normalization | Normalizes supported Agent outputs into answer deltas, plans, status, tool lifecycle, warnings, and terminal results without exposing commands, paths, secrets, or raw chain-of-thought | `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs`; `desktop/test/agents/cli/cli-adapters.test.cjs`; `desktop/test/security/preload-security.test.cjs` |
| Hermes result recovery | Uses a read-only message watermark and a post-watermark final assistant row when available, with sanitized official stdout fallback | `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs`; `desktop/test/agents/cli/cli-adapters.test.cjs` |
| OpenClaw runtime | Isolates native runtime state, keeps API keys out of generated config, validates permission scopes, normalizes supported streaming/tool events in protocol fixtures, and closes disposable ACP sessions plus the authenticated loopback Gateway and in-flight health probes during shutdown | `desktop/test/agents/cli/openclaw-runtime.test.cjs`; `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs`; `desktop/test/agents/cli/cli-native-acp-lifecycle.test.cjs` |
| Conversation controls | Covers group/direct timelines, per-Agent states, retry/stop/replace controls, message actions, and the animated return-to-bottom control including reduced-motion behavior | `frontend/src/__tests__/meldwork/conversationViewport.spec.js`; `frontend/src/__tests__/meldwork/conversationTimeline.spec.js`; `frontend/src/__tests__/meldwork/App.conversation-trace.spec.js` |
| Renderer privacy boundary | Uses the narrow preload bridge and exposes only allowlisted run fields; rejects non-main-frame IPC and unsafe navigation | `frontend/src/__tests__/meldwork/security.spec.js`; `desktop/test/security/main-security.test.cjs`; `desktop/test/security/preload-security.test.cjs` |
| Attachments and Skills | Validates bounded attachment import/storage/preview behavior and target-scoped Skill snapshots without exposing local paths to the renderer | `frontend/src/__tests__/meldwork/App.attachments.spec.js`; `desktop/test/attachments/attachment-store.test.cjs`; `desktop/test/skills/local-skill-catalog.test.cjs` |
| Agent and Knowledge connectors | Enforces approved Connector manifests, scoped instances, durable event reduction, read-only Knowledge lifecycles, and restart-safe references | `desktop/test/agents/connectors/agent-connector-runtime.test.cjs`; `desktop/test/knowledge/knowledge-connector-contract.test.cjs`; `desktop/test/runs/run-event-protocol.test.cjs` |
| Packaging hardening | Applies Electron fuses, removes unused permission declarations, preserves the Bundle ID, and ad-hoc signs local/prerelease packages | `desktop/test/packaging/package-security.test.cjs`; `desktop/test/packaging/after-pack.test.cjs` |
| Formal release fail-closed path | Requires a Developer ID source and complete notarization credentials; rejects ad-hoc identities, missing Team ID, missing Hardened Runtime, or the wrong Bundle ID | `desktop/test/packaging/public-release-preflight.test.cjs`; `desktop/test/packaging/after-sign.test.cjs` |

## CI-Declared Checks

`.github/workflows/ci.yml` declares these push and pull-request checks:

- Frontend: install, unit tests, web build, and desktop renderer build on Ubuntu.
- Desktop: install, unit tests, deterministic Eval Harness, and packaged application build on macOS.

The workflow file does not prove branch-protection configuration or the status of any specific GitHub run.

## Remaining Gaps

| Priority | Gap | Release boundary |
| --- | --- | --- |
| High | No Developer ID signing, Apple notarization, Stapling, or clean-machine Gatekeeper acceptance | V1.0.3 remains an ad-hoc signed prerelease candidate that may require Open Anyway |
| High | OpenClaw has not completed the latest packaged live streaming/tool-lifecycle run | The runtime fails closed with `LOCAL_AGENT_PROCESS_FAILED`; fixture and managed-runtime coverage do not replace live certification |
| Medium | Codex exceeded the 300-second direct acceptance observation window before completing late | UI behavior was accepted with Claude direct; Codex CLI timing still needs a repeatable live matrix |
| Medium | No clean-machine live matrix for every listed Agent and installer recipe | Upstream CLI versions, authentication, and output formats can diverge from fixtures |
| Medium | No production Cloud Agent provider or task-oriented Channel Connector is configured | Mock/framework coverage does not establish a production remote integration |
| Medium | Windows and Intel Mac packages were not built or accepted | V1.0.3 distribution evidence applies only to Apple silicon macOS |
| Low | No comprehensive automated visual-regression, accessibility, or long-history performance suite | Responsive, assistive-technology, and large-history risks still require additional validation |

## Documentation Checks

For each release, validate every backticked test path in this page, run `git diff --check`, and compare `desktop/dist/SHA256SUMS.txt` with fresh `shasum -a 256` output from the release artifacts.
