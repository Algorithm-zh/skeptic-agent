const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}
