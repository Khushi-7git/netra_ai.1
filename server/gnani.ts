// NETRA Gnani Vachana STT & TTS Client (server/gnani.ts)
import {
  GNANI_KEY,
  GNANI_STT_LANGUAGE,
  GNANI_TTS_VOICE,
  GNANI_TTS_LANGUAGE,
  GNANI_TTS_MODE,
} from './config.js';

type TranscribeFunction = (wav: Buffer) => Promise<string>;
type SynthesizeFunction = (text: string, language?: string) => Promise<string | null>;

let mockTranscribeImpl: TranscribeFunction | null = null;
let mockSynthesizeImpl: SynthesizeFunction | null = null;

export function setTranscribeMock(fn: TranscribeFunction | null): void {
  mockTranscribeImpl = fn;
}

export function setSynthesizeMock(fn: SynthesizeFunction | null): void {
  mockSynthesizeImpl = fn;
}

/**
 * Detect Indian language code from Unicode script range when present.
 */
export function detectLanguageFromText(text: string): string | undefined {
  if (!text) return undefined;
  if (/[\u0900-\u097F]/.test(text)) return 'hi-IN'; // Devanagari (Hindi/Marathi)
  if (/[\u0980-\u09FF]/.test(text)) return 'bn-IN'; // Bengali
  if (/[\u0A00-\u0A7F]/.test(text)) return 'pa-IN'; // Gurmukhi (Punjabi)
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu-IN'; // Gujarati
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta-IN'; // Tamil
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te-IN'; // Telugu
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn-IN'; // Kannada
  if (/[\u0D00-\u0D7F]/.test(text)) return 'ml-IN'; // Malayalam
  return undefined;
}

export function resolveTtsLanguage(text: string, preferredLanguage?: string): string {
  const scriptLang = detectLanguageFromText(text);
  if (scriptLang) {
    // Preserve Marathi if explicitly detected/requested for Devanagari text
    if (scriptLang === 'hi-IN' && preferredLanguage === 'mr-IN') {
      return 'mr-IN';
    }
    return scriptLang;
  }
  if (preferredLanguage && preferredLanguage.trim()) {
    return preferredLanguage.trim();
  }
  return GNANI_TTS_LANGUAGE || 'en-IN';
}

export interface SttResult {
  transcript: string;
  detectedLanguage?: string;
}

/**
 * Transcribe WAV audio using Gnani Vachana STT v3 and return transcript + detected language code.
 */
export async function transcribeWithLanguage(wav: Buffer): Promise<SttResult> {
  if (mockTranscribeImpl) {
    const transcript = await mockTranscribeImpl(wav);
    return {
      transcript,
      detectedLanguage: detectLanguageFromText(transcript),
    };
  }

  if (!GNANI_KEY) {
    console.warn('[NETRA:Gnani] GNANI_KEY is not set. STT skipped.');
    return { transcript: '' };
  }

  if (!wav || wav.length === 0) {
    return { transcript: '' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' });
    formData.append('audio_file', audioBlob, 'audio.wav');
    formData.append('model', 'prisma-v3.0');
    formData.append('language_code', GNANI_STT_LANGUAGE);

    const res = await fetch('https://api.vachana.ai/stt/v3', {
      method: 'POST',
      headers: {
        'X-API-Key-ID': GNANI_KEY,
      },
      body: formData,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[NETRA:Gnani STT] HTTP ${res.status}`);
      return { transcript: '' };
    }

    const data: any = await res.json();
    if (data.success === false) {
      console.warn(`[NETRA:Gnani STT] Unsuccessful: ${data.message || 'unknown error'}`);
      return { transcript: '' };
    }

    const transcript = (data.transcript || '').trim();
    const detectedLanguage =
      data.detected_language_code ||
      data.language_code ||
      data.language ||
      detectLanguageFromText(transcript);

    return {
      transcript,
      detectedLanguage: typeof detectedLanguage === 'string' && detectedLanguage.trim()
        ? detectedLanguage.trim()
        : undefined,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[NETRA:Gnani STT] Request timed out after 30s.');
    } else {
      console.warn(`[NETRA:Gnani STT] Error: ${err?.message || err}`);
    }
    return { transcript: '' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Transcribe WAV audio using Gnani Vachana STT v3
 */
export async function transcribe(wav: Buffer): Promise<string> {
  const { transcript } = await transcribeWithLanguage(wav);
  return transcript;
}

/**
 * Synthesize speech to base64 WAV using Gnani Vachana TTS
 */
export async function synthesize(text: string, language?: string): Promise<string | null> {
  if (mockSynthesizeImpl) {
    return await mockSynthesizeImpl(text, language);
  }

  if (!GNANI_KEY || GNANI_TTS_MODE === 'off') {
    return null;
  }

  if (!text || !text.trim()) {
    return null;
  }

  const ttsLanguage = resolveTtsLanguage(text, language);

  const callTts = async (langCode: string): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    try {
      const body = {
        text: text.trim(),
        voice: GNANI_TTS_VOICE,
        model: 'timbre-v2.5',
        language: langCode,
        speed: 1.0,
        audio_config: {
          sample_rate: 24000,
          num_channels: 1,
          sample_width: 2,
          encoding: 'linear_pcm',
          container: 'wav',
        },
      };

      return await fetch('https://api.vachana.ai/api/v1/tts/inference', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key-ID': GNANI_KEY,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    let res = await callTts(ttsLanguage);

    // If a specific language code is rejected, retry once with 'auto'
    if (res.status === 400 && ttsLanguage !== 'auto') {
      res = await callTts('auto');
    }

    if (!res.ok) {
      console.warn(`[NETRA:Gnani TTS] HTTP ${res.status} (lang=${ttsLanguage})`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return null;
    }

    return Buffer.from(arrayBuffer).toString('base64');
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[NETRA:Gnani TTS] Request timed out after 15s.');
    } else {
      console.warn(`[NETRA:Gnani TTS] Error: ${err?.message || err}`);
    }
    return null;
  }
}
