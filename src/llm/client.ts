import { SkepticError } from '../errors';
import type { SkepticConfig } from '../config/schema';

export interface LlmJsonRequest {
  config: SkepticConfig['llm'];
  system: string;
  user: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? (fenced[1] ?? '').trim() : trimmed;
}

export async function requestJson(request: LlmJsonRequest): Promise<unknown> {
  const apiKey = process.env[request.config.apiKeyEnv];
  if (!apiKey) {
    throw new SkepticError(
      'LLM_KEY_MISSING',
      `No API key found in ${request.config.apiKeyEnv}.`,
      'Set the environment variable, or run with --no-llm.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.config.timeoutSec * 1000);
  try {
    const endpoint = `${request.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.config.model,
        temperature: 0,
        max_tokens: 900,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new SkepticError(
        'LLM_REQUEST_FAILED',
        `LLM request failed with HTTP ${response.status}: ${detail}`,
      );
    }

    const payload = (await response.json()) as ChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new SkepticError('LLM_EMPTY_RESPONSE', 'LLM returned an empty response.');
    }
    try {
      return JSON.parse(stripCodeFence(content)) as unknown;
    } catch {
      throw new SkepticError('LLM_INVALID_JSON', 'LLM response was not valid JSON.');
    }
  } catch (error) {
    if (error instanceof SkepticError) {
      throw error;
    }
    if ((error as Error).name === 'AbortError') {
      throw new SkepticError('LLM_TIMEOUT', 'LLM request timed out.');
    }
    throw new SkepticError('LLM_REQUEST_FAILED', (error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
