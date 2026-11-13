// NETRA Gnani Vachana STT & TTS Client (server/gnani.ts)
import {
  GNANI_KEY,
  GNANI_STT_LANGUAGE,
  GNANI_TTS_VOICE,
  GNANI_TTS_LANGUAGE,
  GNANI_TTS_MODE,
} from './config.js';

type TranscribeFunction = (wav: Buffer) => Promise<string>;
type SynthesizeFunction = (text: string) => Promise<string | null>;

let mockTranscribeImpl: TranscribeFunction | null = null;
let mockSynthesizeImpl: SynthesizeFunction | null = null;

export function setTranscribeMock(fn: TranscribeFunction | null): void {
  mockTranscribeImpl = fn;
}

export function setSynthesizeMock(fn: SynthesizeFunction | null): void {
  mockSynthesizeImpl = fn;
}

/**
 * Transcribe WAV audio using Gnani Vachana STT v3
 */
export async function transcribe(wav: Buffer): Promise<string> {
  if (mockTranscribeImpl) {
    return await mockTranscribeImpl(wav);
  }

  if (!GNANI_KEY) {
    console.warn('[NETRA:Gnani] GNANI_KEY is not set. STT skipped.');
    return '';
  }

  if (!wav || wav.length === 0) {
    return '';
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
      return '';
    }

    const data: any = await res.json();
    if (data.success === false) {
      console.warn(`[NETRA:Gnani STT] Unsuccessful: ${data.message || 'unknown error'}`);
      return '';
    }

    return (data.transcript || '').trim();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[NETRA:Gnani STT] Request timed out after 30s.');
    } else {
      console.warn(`[NETRA:Gnani STT] Error: ${err?.message || err}`);
    }
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Synthesize speech to base64 WAV using Gnani Vachana TTS
 */
export async function synthesize(text: string): Promise<string | null> {
  if (mockSynthesizeImpl) {
    return await mockSynthesizeImpl(text);
  }

  if (!GNANI_KEY || GNANI_TTS_MODE === 'off') {
    return null;
  }

  if (!text || !text.trim()) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const body = {
      text: text.trim(),
      voice: GNANI_TTS_VOICE,
      model: 'timbre-v2.5',
      language: GNANI_TTS_LANGUAGE,
      speed: 1.0,
      audio_config: {
        sample_rate: 24000,
        num_channels: 1,
        sample_width: 2,
        encoding: 'linear_pcm',
        container: 'wav',
      },
    };

    const res = await fetch('https://api.vachana.ai/api/v1/tts/inference', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key-ID': GNANI_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[NETRA:Gnani TTS] HTTP ${res.status}`);
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
  } finally {
    clearTimeout(timeoutId);
  }
}
