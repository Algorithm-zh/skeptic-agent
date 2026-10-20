# Evidence receipts

A Skeptic run produces an evidence receipt: a machine-readable record of what was
checked, on which commits, with which commands, and why the verdict came out the
way it did. The receipt is designed to be archived, diffed, and re-read later —
not to be trusted as a cryptographic attestation.

## Artifact layout

Every run writes into the verified repository under `.skeptic/`:

```
.skeptic/
└─ runs/
   └─ 2026-10-20T09-41-22-183Z-a1b2c3/
      ├─ receipt.json
      ├─ report.md
      └─ logs/
         ├─ setup-head.log
         ├─ unit-head.log
         ├─ unit-base.log
         ├─ repro-issue-42-base.log
         └─ repro-issue-42-head.log
```

- `receipt.json` — the canonical evidence record. This is the source of truth.
- `report.md` — a human-readable rendering generated from the receipt.
- `logs/` — full command output for every executed command.

`init` adds `.skeptic/` to `.gitignore`. `verify` also adds it to
`.git/info/exclude` for repositories that have not run `init`, so verification
artifacts never appear as working-tree changes.

Run IDs are UTC timestamps plus a random suffix. Runs are never overwritten.

## Receipt structure

```json
{
  "schemaVersion": 1,
  "tool": { "name": "skeptic", "version": "0.1.0" },
  "createdAt": "2026-10-20T09:41:22.183Z",
  "input": {
    "repository": "my-repo",
    "baseRef": "HEAD",
    "headRef": null,
    "baseSha": "…",
    "headSha": null,
    "dirty": true,
    "diffSha256": "…",
    "changedFiles": 3
  },
  "config": {
    "source": "base",
    "trusted": true,
    "sha256": "…",
    "modified": false
  },
  "environment": { "platform": "win32", "arch": "x64", "node": "v24.18.0", "git": "git version …" },
  "checks": [ … ],
  "reproductions": [ … ],
  "forensics": { "findings": [], "hardCount": 0, "softCount": 0 },
  "claims": [ … ],
  "verdict": { "level": "verified", "reasons": [ … ] },
  "limitations": [ … ],
  "artifacts": { "logsDir": "…", "receiptPath": "…", "reportPath": "…" },
  "receiptSha256": "…"
}
```

### `input`

Identifies exactly what was verified.

- `repository` is the repository directory name only, not an absolute path.
- `baseRef` is the ref that was resolved (`HEAD` by default); `baseSha` is the
  resolved commit.
- `headRef` is `null` when the working tree was verified; `headSha` is `null` in
  that case. `dirty: true` records that uncommitted changes were included.
- `diffSha256` fingerprints the change set: for every changed path it hashes the
  status, old path, and the full-file SHA-256 of the base and head versions,
  sorted by path, then hashes the canonical JSON. Two runs over byte-identical
  inputs produce the same fingerprint even though worktree paths and timestamps
  differ.
- `changedFiles` counts entries from `git diff --name-status -M` plus untracked
  files.

### `config`

Records where the verification contract came from.

| Field | Meaning |
| --- | --- |
| `source: "base"` | Read from the base commit. The normal, trusted case. |
| `source: "trusted-worktree"` | Read from the working tree because the operator passed `--trust-config`. `trusted: true` records that explicit decision, and a limitation notes the config was uncommitted. |
| `source: "override"` | Read from an explicit `--config <path>` and treated as a trusted override. |
| `sha256` | Hash of the exact config text used. |
| `modified` | The head revision's `skeptic.yml` differs from the trusted one. Changes at head are detected but never adopted. |

### `checks` and `reproductions`

Each executed command produces a run record:

```json
{
  "status": "passed",
  "exitCode": 0,
  "durationMs": 1840,
  "timedOut": false,
  "logFile": ".skeptic/runs/…/logs/unit-head.log",
  "logSha256": "…",
  "outputExcerpt": "…",
  "summary": {
    "detected": true,
    "total": 12,
    "passed": 12,
    "failed": 0,
    "skipped": 0,
    "zeroTests": false,
    "allSkipped": false
  }
}
```

- `status` is `passed`, `failed`, `error` (timeout, missing process, or spawn
  failure), or `not_run`. It is derived from the exit code, not from output
  text. A test report claiming "all tests passed" does not override a non-zero
  exit code.
- `summary` is a best-effort parse of Node TAP, Jest, Vitest, and pytest output
  used by the forensics rules. `detected: false` means the output format was not
  recognized; it is not evidence that no tests ran.
- `logSha256` hashes the exact log file on disk. It lets a reader confirm the
  log was not edited after the receipt was written.
- `outputExcerpt` is a truncated, ANSI-stripped excerpt. Snapshot paths are
  replaced with `<base-snapshot>` / `<head-snapshot>` so receipts do not leak
  temporary directories.
- Checks include `attribution` when they failed: `regression` (base passed,
  head failed), `pre_existing_failure` (base also failed), or
  `baseline_unavailable`.
- Reproductions include a `status` (`proven`, `not_proven`, `inconclusive`,
  `tainted`) and, when tainted, a human-readable `taint` explanation.

### `forensics`

`findings` lists every integrity signal with `rule`, `severity` (`hard`, `soft`,
`info`), `title`, `message`, optional `file`/`line`, and an `evidence` snippet.
`hardCount` and `softCount` are denormalized counts for consumers that do not
want to walk the array.

Findings are deterministic heuristics. Each one can be false: a deleted test
file may have been replaced by an equivalent one, and an assertion-count drop
may be a legitimate refactor. The verdict engine treats hard findings as a cap,
not as proof of wrongdoing.

### `claims`

Only present when claims were supplied via `--claims` / `--claims-file` or
extracted by the optional LLM. Each claim records its `source`, `type`, and
`status` (`supported`, `unsupported`, `contradicted`, `informational`), plus the
evidence references used. LLM-extracted claims are advisory; the status is
always computed by the deterministic engine.

### `verdict` and `limitations`

`verdict.level` is one of `verified`, `verified_with_warnings`, `unverified`, or
`failed`; `reasons` lists every rule that contributed. `limitations` records
run-specific caveats such as unblocked network access, failed working-tree
stability checks, allowed install scripts, or an explicitly trusted uncommitted
config. Do not strip limitations before sharing a receipt.

## Canonical JSON and hashing

`receiptSha256` is the SHA-256 of the canonical JSON serialization of the
receipt with `receiptSha256` removed:

1. Recursively sort object keys.
2. Drop `undefined` values.
3. Serialize with `JSON.stringify` (compact, no whitespace).
4. Hash the UTF-8 bytes with SHA-256.

The file on disk is written pretty-printed for humans; the hash is computed over
the canonical form, so reformatting `receipt.json` does not invalidate it.
Changing any value does.

`verifyReceiptHash` recomputes the digest from the parsed object. It confirms
that the receipt body matches its fingerprint. It does **not** prove who wrote
the receipt or that the logs still match — check `logSha256` separately if that
matters.

## Verifying a receipt

```bash
skeptic report                          # latest run
skeptic report --file .skeptic/runs/<run-id>
skeptic report --file .skeptic/runs/<run-id>/receipt.json
```

`skeptic report` prints the Markdown report rendered from the receipt. If the
stored hash does not match the receipt contents, it prints a warning to stderr
and exits `1`. The report is still printed so you can inspect the tampered
content.

To check logs manually:

```bash
sha256sum .skeptic/runs/<run-id>/logs/unit-head.log
```

Compare the result with `checks[].head.logSha256` in the receipt. The same
applies to `setup` and reproduction logs.

## What a receipt proves

- Which base and head commits (or working tree) were verified.
- Which config was used, where it came from, and whether head tried to change it.
- Which commands ran, in which snapshot, with what exit codes, durations, and
  test summaries.
- Which integrity findings were detected and which evidence produced them.
- What verdict the deterministic rules produced and why.
- That the receipt body has not changed since it was finalized (hash).
- That each referenced log matches its recorded hash at the time of checking.

## What a receipt does not prove

- **Authenticity.** Anyone can generate a receipt. There is no signature, key,
  or trusted issuer in v0.1.
- **Completeness.** The rules are heuristics. Semantically equivalent rewrites,
  generated tests, or cleverly weakened assertions can evade them.
- **Safety.** Verification executes repository code. The isolated worktree is
  not a security sandbox, and network access is not blocked.
- **Reproducibility of the environment.** The receipt records platform, arch,
  Node, and Git versions, but dependency resolution may differ later.
- **That the logs are still intact.** Only comparing `logSha256` against the
  files proves that, and only if you trust the receipt's hash.

## Sharing guidance

Receipts and reports are safe to attach to a PR in most cases: they contain no
absolute user paths, no environment variables, and no API keys. Logs are a
different matter.

- Review `logs/` before publishing. Test output can contain fixture data,
  tokens echoed by failing tests, internal URLs, or stack traces with paths.
- Share `.skeptic/runs/<run-id>/receipt.json` and `report.md` as the primary
  evidence; attach logs only when needed.
- In CI, upload the entire run directory as an artifact and link the job
  summary. Artifacts expire; archive receipts separately if they are part of a
  release record.
- If you need to redact a log, record the redaction. Editing a log breaks its
  `logSha256` and should be disclosed alongside the receipt.

## Compatibility policy

`schemaVersion` is `1`. Additive fields may appear in minor releases; consumers
should ignore unknown fields. Removing or changing the meaning of a field
requires a new schema version. `skeptic report` validates the shape and rejects
unknown schema versions instead of guessing.
