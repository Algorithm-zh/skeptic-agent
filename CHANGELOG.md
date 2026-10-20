# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-20

First public release.

### Added

- `skeptic init` to create a trusted `skeptic.yml` and ignore verification
  artifacts.
- `skeptic verify` with base/head snapshots, dirty working-tree overlay, and
  automatic baseline attribution when a required check fails.
- Graded verdicts: `verified`, `verified_with_warnings`, `unverified`, `failed`,
  with configurable CI exit behavior via `--fail-on`.
- Reproductions declared in config, run against base and head, with proof taint
  when tests are modified, weakened, or reduced.
- Deterministic forensics for deleted or emptied test files, zero executed
  tests, fully skipped suites, weakened assertions, disabled or modified check
  commands, CI bypasses, lockfile drift, new install scripts, and protected file
  changes.
- Heuristic claim extraction for test-pass and bug-fix claims, with an optional
  OpenAI-compatible LLM extractor that cannot affect the verdict.
- Evidence receipts with canonical JSON, SHA-256 integrity fingerprints, log
  hashes, Markdown reports, and path sanitization.
- Environment scrubbing, `ignore-scripts` by default, per-command timeouts,
  output limits, and cross-platform process-tree termination.
- `skeptic demo` with four zero-dependency, zero-key scenarios.
- `skeptic report` for re-rendering and hash-checking stored receipts.
- `skeptic doctor` for environment and configuration diagnostics.
- A 12-scenario fixture matrix (`npm run bench`) covering legitimate changes,
  hard tampering, soft warnings, regressions, and pre-existing failures.
- Composite GitHub Action that verifies a pull request, writes a job summary,
  and uploads the run directory as an artifact.
- CI on Ubuntu and Windows with Node.js 22 and 24, plus a package smoke test.
- English and Chinese READMEs, design notes, threat model, and receipt
  documentation.

### Known limitations

- Verification is not sandboxed: verified code can access the network and the
  host file system.
- Receipts are unsigned; hashes provide integrity, not authenticity.
- Forensics are heuristics and cannot prove semantic equivalence.
- Automatic project detection is limited to npm during `init`; other ecosystems
  require explicit check commands.
- No Docker sandbox, SARIF output, PR comments, badges, or hosted service yet.

[Unreleased]: https://github.com/Algorithm-zh/skeptic-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Algorithm-zh/skeptic-agent/releases/tag/v0.1.0
