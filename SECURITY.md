# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | Not released |

Skeptic is a pre-1.0 tool. Security fixes land on the latest release line.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

<https://github.com/Algorithm-zh/skeptic-agent/security/advisories/new>

Do not open a public issue for a suspected vulnerability. Include:

- Skeptic version, OS, Node version, and Git version.
- A minimal reproduction or fixture repository if possible.
- The impact: what an attacker gains, and what preconditions are required.
- Whether the issue affects the CLI, the GitHub Action, or both.

You will receive an acknowledgment on a best-effort basis, usually within a
week. There is no bug bounty. Please allow time for a fix before disclosure.

## Security model

Skeptic executes code from the repository it verifies. This is the core
function, not a bug. The isolated Git worktree protects the user's working tree
and index from modification; it is **not** a security sandbox and does not
prevent the verified code from reading files, using the network, or consuming
resources available to the process.

The threat model is documented in full in [`docs/THREAT_MODEL.md`](THREAT_MODEL.md).
The guarantees Skeptic does provide:

- Commands are taken from a trusted configuration, never from agent claims.
- The trusted config is read from the base revision; head-side changes are
  detected and never adopted.
- Secrets matching common patterns are removed from the child environment, and
  only an explicit allowlist of variables is passed through.
- Install lifecycle scripts are disabled by default (`npm_config_ignore_scripts`).
- Commands have timeouts and output limits, and process trees are terminated.
- Verification artifacts are written under `.skeptic/` and excluded from Git.
- The receipt hash detects edits to the receipt body; log hashes detect edits to
  individual logs.

## In scope

- A claim, model response, or head-side config causing command execution.
- Secret values or `GITHUB_TOKEN` leaking into verified code, receipt output, or
  logs beyond what the verified code itself prints.
- Path traversal or writes outside `.skeptic/` and the temporary snapshot
  directory, including through malformed manifests or symlinks.
- A malicious repository causing the user's tracked files, index, branches, or
  worktrees to change.
- LLM prompt injection that changes a verdict, a finding, or command execution.
- GitHub Action issues: credential persistence, write-scoped tokens,
  `pull_request_target` usage, or untrusted input flowing into `run:` scripts.
- Receipt hash bypass: a receipt modified without `skeptic report` detecting it.

## Out of scope

- Verified code reading files, using the network, or attacking the host. Run
  Skeptic in a disposable container or ephemeral CI runner.
- A repository running a denial-of-service workload within the configured
  timeout, or exhausting disk through logs within the 10 MB per-command cap.
- False negatives in forensics rules. Report these as regular bugs with a
  fixture; they are quality issues, not vulnerabilities.
- Forged receipts. Receipts provide integrity, not authenticity; anyone can
  generate one.
- The consequences of passing `--allow-scripts`, `--trust-config`, or repository
  secrets to verified code. These are explicit operator decisions.
- Vulnerabilities in Git, Node.js, npm, or dependencies that are already fixed
  upstream; report those upstream.

## Secure deployment guidance

- Run Skeptic on ephemeral CI runners, never on a long-lived developer machine
  with credentials in the environment.
- In GitHub Actions, trigger on `pull_request`, use `permissions: contents: read`,
  set `persist-credentials: false`, and do not expose secrets to the job.
- Do not use `pull_request_target` to verify fork code.
- Keep `allowScripts: false` unless the repository genuinely requires install
  lifecycle scripts, and understand that they run with the same privileges as
  checks.
- Review logs before sharing; logs can contain output produced by untrusted
  code.
- Treat receipts as evidence records, not as attestations. Sign them separately
  if you need authenticity.

## Dependency and disclosure policy

Security-relevant dependency updates are merged promptly. If a vulnerability
requires a breaking change to the receipt schema or config format, the fix will
be documented in the release notes and, where feasible, a new schema version
will be introduced rather than silently changing the meaning of existing
fields.
