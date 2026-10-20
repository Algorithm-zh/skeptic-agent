const TEST_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.skeptic',
  'dist',
  'build',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

const TEST_FILE_PATTERNS: RegExp[] = [
  /(?:^|\/)(?:__tests__|tests?|spec)\/.+\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|cs|go|rs|swift)$/i,
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|cs|rs)$/i,
  /(?:^|\/)test_[^/]+\.py$/i,
  /(?:^|\/)[^/]+_test\.(?:py|go|rb|exs)$/i,
  /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift)$/,
];

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const TEST_CONFIG_PATTERNS = [
  /(?:^|\/)(?:vitest|jest|playwright|cypress|karma|mocha|ava)\.config\.[cm]?[jt]s$/i,
  /(?:^|\/)\.mocharc(?:\.[a-z]+)?$/i,
  /(?:^|\/)pytest\.ini$/i,
  /(?:^|\/)pyproject\.toml$/i,
  /(?:^|\/)tox\.ini$/i,
  /(?:^|\/)\.nycrc(?:\.[a-z]+)?$/i,
];

export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => TEST_DIRECTORIES.has(segment))) {
    return false;
  }
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isCiFile(filePath: string): boolean {
  return /^\.github\/workflows\/.+\.ya?ml$/i.test(filePath.replace(/\\/g, '/'));
}

export function isLockfile(filePath: string): boolean {
  const name = filePath.replace(/\\/g, '/').split('/').at(-1) ?? '';
  return LOCKFILES.has(name);
}

export function isTestConfigFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_CONFIG_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    normalized.split('/').at(-1) === 'package.json';
}

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function globToRegExp(glob: string): RegExp {
  let source = '';
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function isProtectedPath(filePath: string, patterns: string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}
