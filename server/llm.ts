// NETRA Groq LLM Client (server/llm.ts)
import { GROQ_KEY, GROQ_MODEL } from './config.js';

let globalRateLimitUntil = 0;
let activeGroqModel = GROQ_MODEL;

// Models known to support multimodal vision and chat on Groq
const CANDIDATE_FALLBACK_MODELS = [
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];

export function getActiveGroqModel(): string {
  return activeGroqModel;
}

export function setActiveGroqModel(model: string): void {
  activeGroqModel = model;
}

export function getGlobalRateLimitStatus(now: number = Date.now()): {
  isRateLimited: boolean;
  retryAfter: number;
} {
  if (globalRateLimitUntil > now) {
    const retryAfter = Math.ceil((globalRateLimitUntil - now) / 1000);
    return { isRateLimited: true, retryAfter };
  }
  return { isRateLimited: false, retryAfter: 0 };
}

export function setGlobalRateLimit(seconds: number): void {
  const retrySec = Math.max(1, Math.ceil(seconds || 20));
  globalRateLimitUntil = Date.now() + retrySec * 1000;
}

export function resetGlobalRateLimit(): void {
  globalRateLimitUntil = 0;
}

export function cleanAndParseJson<T = any>(rawText: string | undefined): T | null {
  if (!rawText || typeof rawText !== 'string') return null;
  let clean = rawText.trim();

  // Strip markdown fences
  if (clean.startsWith('```json')) {
    clean = clean.slice(7);
  } else if (clean.startsWith('```')) {
    clean = clean.slice(3);
  }
  if (clean.endsWith('```')) {
    clean = clean.slice(0, -3);
  }
  clean = clean.trim();

  try {
    return JSON.parse(clean);
  } catch {
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch && fenceMatch[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {}
    }

    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(clean.slice(firstBrace, lastBrace + 1));
      } catch {}
    }

    const firstBracket = clean.indexOf('[');
    const lastBracket = clean.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(clean.slice(firstBracket, lastBracket + 1));
      } catch {}
    }
    return null;
  }
}

type AskJsonFunction = (
  prompt: string,
  imageB64?: string,
  temperature?: number,
  timeoutMs?: number
) => Promise<any | null>;

let mockAskJsonImpl: AskJsonFunction | null = null;

export function setAskJsonMock(fn: AskJsonFunction | null): void {
  mockAskJsonImpl = fn;
}

export async function askJson(
  prompt: string,
  imageB64?: string,
  temperature: number = 0.3,
  timeoutMs: number = 20000
): Promise<any | null> {
  if (mockAskJsonImpl) {
    return await mockAskJsonImpl(prompt, imageB64, temperature, timeoutMs);
  }

  if (!GROQ_KEY) {
    console.warn('[NETRA:Groq] GROQ_KEY is missing. Model call skipped.');
    return null;
  }

  const userContent: any[] = [{ type: 'text', text: prompt }];
  if (imageB64 && typeof imageB64 === 'string' && imageB64.trim().length > 0) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${imageB64}`,
      },
    });
  }

  const messages = [{ role: 'user', content: userContent }];

  const makeCallWithModel = async (
    modelName: string,
    includeResponseFormat: boolean
  ): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const bodyObj: Record<string, any> = {
      model: modelName,
      temperature,
      messages,
    };
    if (includeResponseFormat) {
      bodyObj.response_format = { type: 'json_object' };
    }

    try {
      return await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    let currentModel = activeGroqModel;
    let res = await makeCallWithModel(currentModel, true);

    // If model returns 404 (model not found / decommissioned / no access), attempt fallback models
    if (res.status === 404) {
      console.warn(
        `[NETRA:Groq] Model "${currentModel}" returned 404. Attempting candidate fallback models...`
      );
      for (const fallback of CANDIDATE_FALLBACK_MODELS) {
        if (fallback === currentModel) continue;
        const candidateRes = await makeCallWithModel(fallback, true);
        if (candidateRes.status === 429) {
          res = candidateRes;
          break;
        }
        if (candidateRes.ok) {
          res = candidateRes;
          activeGroqModel = fallback;
          currentModel = fallback;
          console.log(`[NETRA:Groq] Successfully switched active model to: ${fallback}`);
          break;
        } else if (candidateRes.status === 400 && imageB64) {
          // If response_format with image is rejected (400), try fallback without response_format
          const retryRes = await makeCallWithModel(fallback, false);
          if (retryRes.ok) {
            res = retryRes;
            activeGroqModel = fallback;
            currentModel = fallback;
            console.log(`[NETRA:Groq] Successfully switched active model to: ${fallback}`);
            break;
          }
        }
      }
    }

    if (res.status === 429) {
      const retryHeader = res.headers.get('retry-after');
      let retrySec = 20;
      if (retryHeader) {
        const parsed = parseFloat(retryHeader);
        if (!isNaN(parsed) && parsed > 0) retrySec = Math.ceil(parsed);
      }
      setGlobalRateLimit(retrySec);
      console.warn(`[NETRA] Groq 429 rate limit. Retry delay: ${retrySec}s`);
      return null;
    }

    // If Groq rejects response_format together with an image (HTTP 400), retry once without it
    if (res.status === 400 && imageB64) {
      res = await makeCallWithModel(currentModel, false);
      if (res.status === 429) {
        const retryHeader = res.headers.get('retry-after');
        let retrySec = 20;
        if (retryHeader) {
          const parsed = parseFloat(retryHeader);
          if (!isNaN(parsed) && parsed > 0) retrySec = Math.ceil(parsed);
        }
        setGlobalRateLimit(retrySec);
        console.warn(`[NETRA] Groq 429 rate limit. Retry delay: ${retrySec}s`);
        return null;
      }
    }

    if (!res.ok) {
      console.warn(`[NETRA:Groq] HTTP error ${res.status}`);
      return null;
    }

    const data: any = await res.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    return cleanAndParseJson(rawContent);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[NETRA:Groq] Request timed out.');
    } else {
      console.warn(`[NETRA:Groq] Error: ${err?.message || err}`);
    }
    return null;
  }
}
