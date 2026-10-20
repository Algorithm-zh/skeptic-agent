export type VerdictLevel = 'verified' | 'verified_with_warnings' | 'unverified' | 'failed';

export type CheckRunStatus = 'passed' | 'failed' | 'error' | 'not_run';

export interface TestSummary {
  detected: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  zeroTests: boolean;
  allSkipped: boolean;
}

export interface RunResult {
  status: CheckRunStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  logFile: string;
  logSha256: string;
  outputExcerpt: string;
  summary: TestSummary;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileLine {
  line: number;
  text: string;
}

export interface FileChange {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
  isBinary: boolean;
  additions: number;
  deletions: number;
  addedLines: FileLine[];
  removedLines: FileLine[];
  baseSha256: string;
  headSha256: string;
}

export interface TestFileStats {
  tests: number;
  assertions: number;
}

export interface Inventory {
  testFiles: number;
  testCount: number;
  assertionCount: number;
  files: string[];
  fileTests: Record<string, TestFileStats>;
  partial: boolean;
}

export type FindingSeverity = 'hard' | 'soft' | 'info';

export interface Finding {
  rule: string;
  severity: FindingSeverity;
  title: string;
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export type ClaimType = 'tests_pass' | 'bug_fixed' | 'other';

export type ClaimStatus = 'supported' | 'unsupported' | 'contradicted' | 'informational';

export interface Claim {
  text: string;
  type: ClaimType;
  checkId?: string;
  issue?: number;
  source: 'heuristic' | 'llm' | 'user';
  status: ClaimStatus;
  material: boolean;
  evidence: string[];
  rationale?: string;
}

export type CheckAttribution = 'regression' | 'pre_existing_failure' | 'baseline_unavailable';

export interface CheckResult {
  id: string;
  name: string;
  required: boolean;
  command: string;
  head?: RunResult;
  base?: RunResult;
  attribution?: CheckAttribution;
}

export type ReproductionStatus = 'proven' | 'not_proven' | 'inconclusive' | 'tainted';

export interface ReproductionResult {
  id: string;
  name: string;
  command: string;
  base?: RunResult;
  head?: RunResult;
  status: ReproductionStatus;
  taint?: string;
}

export interface ConfigInfo {
  source: 'base' | 'override' | 'trusted-worktree';
  trusted: boolean;
  sha256: string;
  modified: boolean;
}

export interface VerdictInfo {
  level: VerdictLevel;
  reasons: string[];
}

export interface ReceiptInput {
  repository: string;
  baseRef: string;
  headRef: string | null;
  baseSha: string;
  headSha: string | null;
  dirty: boolean;
  diffSha256: string;
  changedFiles: number;
}

export interface ReceiptEnvironment {
  platform: string;
  arch: string;
  node: string;
  git?: string;
}

export interface ReceiptArtifacts {
  logsDir: string;
  receiptPath: string;
  reportPath: string;
}

export interface Receipt {
  schemaVersion: 1;
  tool: { name: 'skeptic'; version: string };
  createdAt: string;
  input: ReceiptInput;
  config: ConfigInfo;
  setup?: RunResult;
  environment: ReceiptEnvironment;
  checks: CheckResult[];
  reproductions: ReproductionResult[];
  forensics: {
    findings: Finding[];
    hardCount: number;
    softCount: number;
  };
  claims: Claim[];
  verdict: VerdictInfo;
  limitations: string[];
  artifacts: ReceiptArtifacts;
  receiptSha256: string;
}

export type FailOnMode = 'warnings' | 'unverified' | 'never';

export interface VerifyOptions {
  repoPath: string;
  base?: string;
  head?: string;
  claimsText?: string;
  configPath?: string;
  trustConfig?: boolean;
  allowScripts?: boolean;
  llm?: boolean;
  failOn?: FailOnMode;
  keepWorktrees?: boolean;
  onProgress?: (message: string) => void;
}

export interface VerifyOutcome {
  receipt: Receipt;
  receiptPath: string;
  reportPath: string;
  markdown: string;
  exitCode: number;
}
