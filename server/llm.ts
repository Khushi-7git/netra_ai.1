// NETRA Groq LLM Client (server/llm.ts)
import { GROQ_KEY, GROQ_MODEL } from './config.js';

let globalRateLimitUntil = 0;
let activeVisionModel = GROQ_MODEL;
let activeTextModel = GROQ_MODEL;

// Vision-capable models on Groq (never fall back to text-only models for image requests)
const CANDIDATE_VISION_MODELS = [
  'qwen/qwen3.8-27b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
];

// Text-capable models on Groq
const CANDIDATE_TEXT_MODELS = [
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
];

export function getActiveGroqModel(): string {
  return activeVisionModel;
}

export function setActiveGroqModel(model: string): void {
  activeVisionModel = model;
  activeTextModel = model;
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

function handleRateLimitResponse(res: Response): void {
  const retryHeader = res.headers.get('retry-after');
  let retrySec = 20;
  if (retryHeader) {
    const parsed = parseFloat(retryHeader);
    if (!isNaN(parsed) && parsed > 0) retrySec = Math.ceil(parsed);
  }
  setGlobalRateLimit(retrySec);
  console.warn(`[NETRA] Groq 429 rate limit. Retry delay: ${retrySec}s`);
}

function sanitizeImageBase64(imageB64?: string): string | null {
  if (!imageB64 || typeof imageB64 !== 'string') return null;
  const cleaned = imageB64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
  return cleaned.length > 0 ? cleaned : null;
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

  const cleanImg = sanitizeImageBase64(imageB64);
  const hasImage = Boolean(cleanImg);

  const userContent: any[] = [{ type: 'text', text: prompt }];
  if (cleanImg) {
    const mime = cleanImg.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${mime};base64,${cleanImg}`,
      },
    });
  }

  const messages = [{ role: 'user', content: hasImage ? userContent : prompt }];

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
    const primaryModel = hasImage ? activeVisionModel : activeTextModel;
    const candidatePool = hasImage ? CANDIDATE_VISION_MODELS : CANDIDATE_TEXT_MODELS;
    const modelsToTry = [primaryModel, ...candidatePool.filter((m) => m !== primaryModel)];

    let lastStatus = 0;
    let lastErrorText = '';

    for (const modelName of modelsToTry) {
      let res = await makeCallWithModel(modelName, true);

      if (res.status === 429) {
        handleRateLimitResponse(res);
        return null;
      }

      // If response_format is rejected (HTTP 400), retry once on same model without it
      if (res.status === 400) {
        const retryRes = await makeCallWithModel(modelName, false);
        if (retryRes.status === 429) {
          handleRateLimitResponse(retryRes);
          return null;
        }
        res = retryRes;
      }

      if (res.ok) {
        if (hasImage) {
          if (activeVisionModel !== modelName) {
            console.log(`[NETRA:Groq] Switched active vision model to: ${modelName}`);
            activeVisionModel = modelName;
          }
        } else if (activeTextModel !== modelName) {
          console.log(`[NETRA:Groq] Switched active text model to: ${modelName}`);
          activeTextModel = modelName;
        }

        const data: any = await res.json();
        const rawContent = data?.choices?.[0]?.message?.content;
        return cleanAndParseJson(rawContent);
      }

      lastStatus = res.status;
      try {
        lastErrorText = (await res.text()).slice(0, 300);
      } catch {
        lastErrorText = '';
      }

      // Retry next candidate model on 404 (not found / decommissioned) or 400 (unsupported feature / model mismatch)
      if (res.status === 404 || res.status === 400) {
        console.log(
          `[NETRA:Groq] Model "${modelName}" returned HTTP ${res.status}; trying next fallback...`
        );
        continue;
      }

      break;
    }

    console.warn(
      `[NETRA:Groq] HTTP error ${lastStatus}${lastErrorText ? ` (${lastErrorText})` : ''}`
    );
    return null;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[NETRA:Groq] Request timed out.');
    } else {
      console.warn(`[NETRA:Groq] Error: ${err?.message || err}`);
    }
    return null;
  }
}
