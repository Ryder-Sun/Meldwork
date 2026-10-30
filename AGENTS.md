# Meldwork Development Rules

## Working Style

- Read the relevant code path before editing and state assumptions when behavior is unclear.
- Keep changes small and directly tied to the request. Do not refactor adjacent code without a concrete need.
- Before editing, name the files you will change and why. Use patch-based edits for reviewable changes.
- Do not place screenshots, logs, generated packages, or temporary files in the repository root.

## Product Boundaries

- Meldwork is a local-first desktop application. Do not introduce a required server, container, or cluster dependency unless the task explicitly calls for it.
- Keep Agent execution in the Electron main process. Renderer access must go through narrow, validated preload APIs.
- Respect native Agent configuration and keep CLI integration provider-agnostic. Do not add gateway-specific adapters, provider overrides, or bundled patches for external tools such as Magpie.
- Never expose executable paths, tokens, credentials, or unrestricted shell execution to renderer code.
- Store secrets only through operating-system-backed secure storage. Do not add plaintext fallbacks.
- Keep workspace write access opt-in. Conversations and groups stay local; do not add remote participants, cloud channels, or remote conversation storage.

## Frontend And Desktop

- User-visible text must support both Chinese and English through the existing i18n system.
- Changes to chat behavior must be checked in Electron desktop mode.
- New overlays must support Escape/back dismissal and prevent background scroll where applicable.
- Preserve the existing visual language and responsive behavior; avoid unrelated redesigns.

## Verification

- Frontend tests: `npm --prefix frontend test`
- Frontend builds: `npm --prefix frontend run build` and `npm --prefix frontend run build:desktop`
- Desktop tests: `npm --prefix desktop test`
- Desktop package validation: `npm --prefix desktop run pack`
- Add or update focused tests when changing behavior, security boundaries, output structures, or conditional logic.
- Report commands run and any verification that could not be completed.

## Git Hygiene

- Preserve unrelated user changes and never use destructive Git commands without explicit approval.
- Commit messages should explain what changed, why it changed, and which checks were run.
- Do not add generated dependencies, build output, credentials, or release artifacts to version control.
