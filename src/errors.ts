export class SkepticError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'SkepticError';
    this.code = code;
    this.hint = hint;
  }
}
