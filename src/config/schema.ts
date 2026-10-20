import { z } from 'zod';

export const DEFAULT_PROTECTED = [
  'test/**',
  'tests/**',
  '__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/*_test.py',
  '.github/workflows/**',
  'skeptic.yml',
  'vitest.config.*',
  'jest.config.*',
  'pytest.ini',
  'pyproject.toml',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

const checkSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/, 'check id may only contain letters, numbers, _ and -'),
    name: z.string().min(1).optional(),
    run: z.string().min(1),
    required: z.boolean().default(true),
    timeoutSec: z.number().positive().max(3600).default(300),
  })
  .strict();

const reproductionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/, 'reproduction id may only contain letters, numbers, _ . and -'),
    name: z.string().min(1).optional(),
    run: z.string().min(1),
    expect: z.literal('fail-before-pass-after').default('fail-before-pass-after'),
  })
  .strict();

const envSchema = z
  .object({
    pass: z.array(z.string()).default([]),
    set: z.record(z.string()).default({}),
  })
  .strict();

const llmSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    model: z.string().min(1).default('gpt-4o-mini'),
    apiKeyEnv: z.string().min(1).default('SKEPTIC_API_KEY'),
    timeoutSec: z.number().positive().max(300).default(30),
  })
  .strict();

export const skepticConfigSchema = z
  .object({
    version: z.literal(1),
    setup: z.string().min(1).optional(),
    checks: z.array(checkSchema).min(1),
    reproductions: z.array(reproductionSchema).default([]),
    protected: z.array(z.string()).default(DEFAULT_PROTECTED),
    env: envSchema.default({ pass: [], set: {} }),
    allowScripts: z.boolean().default(false),
    llm: llmSchema.default({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKeyEnv: 'SKEPTIC_API_KEY',
      timeoutSec: 30,
    }),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const check of config.checks) {
      if (ids.has(check.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks'],
          message: `duplicate check id: ${check.id}`,
        });
      }
      ids.add(check.id);
    }
    const reproductionIds = new Set<string>();
    for (const reproduction of config.reproductions) {
      if (reproductionIds.has(reproduction.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reproductions'],
          message: `duplicate reproduction id: ${reproduction.id}`,
        });
      }
      reproductionIds.add(reproduction.id);
    }
  });

export type SkepticConfig = z.infer<typeof skepticConfigSchema>;
export type CheckConfig = SkepticConfig['checks'][number];
export type ReproductionConfig = SkepticConfig['reproductions'][number];

export function formatConfigIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
