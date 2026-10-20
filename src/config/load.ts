import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { SkepticError } from '../errors';
import { readFileAtRef, readWorkingFile } from '../git/git';
import { sha256 } from '../util/hash';
import type { ConfigInfo } from '../types';
import { formatConfigIssues, skepticConfigSchema, type SkepticConfig } from './schema';

export interface LoadedConfig {
  config: SkepticConfig;
  info: ConfigInfo;
  raw: string;
  headRaw?: string;
}

export interface LoadConfigOptions {
  repoPath: string;
  baseRef: string;
  headRef?: string;
  configPath?: string;
  trustConfig?: boolean;
}

export function normalizeConfigText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function parseConfigText(text: string, label = 'skeptic.yml'): SkepticConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw new SkepticError(
      'CONFIG_PARSE_ERROR',
      `Could not parse ${label}: ${(error as Error).message}`,
    );
  }
  const result = skepticConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SkepticError(
      'CONFIG_INVALID',
      `Invalid ${label}: ${formatConfigIssues(result.error)}`,
      'Run `skeptic init` to generate a working configuration.',
    );
  }
  return result.data;
}

async function readHeadConfig(options: LoadConfigOptions): Promise<string | undefined> {
  if (options.headRef) {
    const snapshot = await readFileAtRef(options.repoPath, options.headRef, 'skeptic.yml');
    return snapshot?.text;
  }
  const snapshot = await readWorkingFile(options.repoPath, 'skeptic.yml');
  return snapshot?.text;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const headRaw = await readHeadConfig(options);

  if (options.configPath) {
    const configPath = path.isAbsolute(options.configPath)
      ? options.configPath
      : path.resolve(options.repoPath, options.configPath);
    let raw: string;
    try {
      raw = await readFile(configPath, 'utf8');
    } catch {
      throw new SkepticError('CONFIG_NOT_FOUND', `Could not read config: ${configPath}`);
    }
    const config = parseConfigText(raw, configPath);
    return {
      config,
      raw,
      headRaw,
      info: {
        source: 'override',
        trusted: true,
        sha256: sha256(normalizeConfigText(raw)),
        modified: false,
      },
    };
  }

  const baseSnapshot = await readFileAtRef(options.repoPath, options.baseRef, 'skeptic.yml');
  if (baseSnapshot) {
    if (baseSnapshot.isBinary) {
      throw new SkepticError('CONFIG_INVALID', 'skeptic.yml at the base ref is binary.');
    }
    const raw = baseSnapshot.text;
    const config = parseConfigText(raw, `skeptic.yml at ${options.baseRef}`);
    const modified =
      headRaw === undefined ||
      normalizeConfigText(headRaw) !== normalizeConfigText(raw);
    return {
      config,
      raw,
      headRaw,
      info: {
        source: 'base',
        trusted: true,
        sha256: sha256(normalizeConfigText(raw)),
        modified,
      },
    };
  }

  if (!options.trustConfig) {
    throw new SkepticError(
      'CONFIG_UNTRUSTED',
      'No committed skeptic.yml was found at the base ref.',
      'Commit a skeptic.yml, or explicitly trust an uncommitted config with --trust-config.',
    );
  }

  if (!headRaw) {
    throw new SkepticError(
      'CONFIG_NOT_FOUND',
      'No skeptic.yml found. Run `skeptic init` first.',
    );
  }

  const config = parseConfigText(headRaw, 'uncommitted skeptic.yml');
  return {
    config,
    raw: headRaw,
    headRaw,
    info: {
      source: 'trusted-worktree',
      trusted: true,
      sha256: sha256(normalizeConfigText(headRaw)),
      modified: false,
    },
  };
}
