// NETRA Server Configuration (Groq & Gnani Vachana)
import dotenv from 'dotenv';
dotenv.config();

// Secrets (read from process.env on server only)
export const GROQ_KEY = process.env.GROQ_KEY || '';
export const GNANI_KEY = process.env.GNANI_KEY || '';

// Optional models and speech settings
export const GROQ_MODEL =
  process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
export const GNANI_STT_LANGUAGE = process.env.GNANI_STT_LANGUAGE || 'indic-auto';
export const GNANI_TTS_VOICE = process.env.GNANI_TTS_VOICE || 'Nalini';
export const GNANI_TTS_LANGUAGE = process.env.GNANI_TTS_LANGUAGE || 'en-IN';
export const GNANI_TTS_MODE = (process.env.GNANI_TTS_MODE || 'all') as
  | 'inquiry'
  | 'all'
  | 'off';

export const QUOTA_RPM = 20;
export const SCAN_INTERVAL_MS = 15000;
export const MICRO_INTERVAL_MS = 2000;

export const IMAGE_SIZE = {
  maxWidth: 224,
  maxHeight: 160,
};

export const MICRO_IMAGE_SIZE = {
  maxWidth: 224,
  maxHeight: 224,
};

export const MODEL_TIMEOUT = 20000; // 20s safety timeout

export const SPEECH_INTERVALS: Record<string, number> = {
  critical: 1.0,
  high: 2.0,
  medium: 4.0,
  low: 8.0,
};

export const DISTANCE_THRESHOLDS = {
  critical: 0.5,
  danger: 1.0,
  caution: 2.0,
};

export const CLIENT_INTERVALS = {
  scanInterval: SCAN_INTERVAL_MS,
  microInterval: MICRO_INTERVAL_MS,
};
