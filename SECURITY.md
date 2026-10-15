# Security Policy

Meldwork is a local-first desktop application that invokes local Agent CLIs, stores local conversations, imports validated image, media, document, code, and archive attachments, and runs each Agent with its own native CLI credentials through the Electron main process.

## Reporting

Please report security issues privately through GitHub Security Advisories for this repository, or contact the repository owner through GitHub if advisories are unavailable.

Do not open a public issue with exploit details, secrets, local file paths, or private workspace data.

## In Scope

- Renderer-to-main IPC authorization bypasses.
- Exposure of executable paths, attachment paths, native session references, CLI API keys, or Skill file paths to renderer code.
- Arbitrary shell execution, arbitrary file read/write, unsafe navigation, or unsafe installer behavior.
- Attachment validation, private storage, checksum, or preview isolation failures.
- Credential storage failures that expose secrets.

## Out of Scope

- Vulnerabilities in upstream Agent CLIs, model Providers, or third-party package registries.
- Issues that require changing the local operating-system user's account permissions.
- Reports based only on missing enterprise features such as SSO, centralized audit logs, device management, or notarized public release distribution.

## Supported Version

The current repository state is a market-validation MVP. Security fixes target the default branch unless a release branch is explicitly created.
