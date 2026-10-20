const BASE_ALLOWLIST = new Set([
  'path',
  'pathext',
  'systemroot',
  'systemdrive',
  'windir',
  'comspec',
  'temp',
  'tmp',
  'home',
  'userprofile',
  'appdata',
  'localappdata',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'number_of_processors',
  'processor_architecture',
  'os',
  'lang',
  'lc_all',
  'term',
  'ci',
]);

export function createCleanEnv(
  pass: string[] = [],
  set: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && BASE_ALLOWLIST.has(key.toLowerCase())) {
      env[key] = value;
    }
  }

  for (const name of pass) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  Object.assign(env, set);
  delete env.NODE_OPTIONS;

  if (!env.PATH && !env.Path) {
    env.PATH = process.env.PATH ?? '';
  }
  if (!env.CI) {
    env.CI = '1';
  }
  if (!env.TERM) {
    env.TERM = 'dumb';
  }
  env.FORCE_COLOR = env.FORCE_COLOR ?? '0';

  return env;
}
