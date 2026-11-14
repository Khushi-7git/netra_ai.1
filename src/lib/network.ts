import { spatialAudio, audioQueue } from './audio';

export interface AppState {
  scanInterval: number;
  microInterval: number;
  active: boolean;
  debug: boolean;
  mode: 'nav' | 'micro' | 'task';
  heading: number;
  lastShake: number;
  lastGeiger: number;
  sessionId: string;
}

export interface RouterCallbacks {
  showFeedback: (text: string) => void;
  updateStatus: (text: string, cls: string) => void;
  restartLoop: (intervalMs: number) => void;
  updateNavUI: (msg: any) => void;
  updateMicroUI: (msg: any) => void;
  updateTaskUI: (msg: any) => void;
  updateInquiryUI: (msg: any) => void;
  announce: (text: string) => void;
}

export function handleServerMessage(
  msg: any,
  state: AppState,
  cb: RouterCallbacks
): void {
  if (!msg) return;

  // 1. Mode changes
  if (msg.mode && msg.mode !== state.mode) {
    state.mode = msg.mode;
    if (msg.mode === 'micro') {
      cb.showFeedback('MICRO MODE');
      spatialAudio.startMicroTone();
      cb.updateStatus('Precision', 'active');
      cb.restartLoop(state.microInterval);
    } else {
      cb.showFeedback(msg.mode === 'task' ? 'TASK MODE' : 'NAV MODE');
      spatialAudio.stopMicroTone();
      cb.updateStatus('Scanning', 'active');
      cb.restartLoop(state.scanInterval);
    }
  }

  // 2. Audio feedback
  if (msg.type === 'micro_result') {
    const x = Number(msg.x ?? 0);
    const y = Number(msg.y ?? 0);
    spatialAudio.updateMicroTone(x, y);

    const dist = Math.sqrt(x * x + y * y);
    const proximity = 1 - Math.min(dist, 140) / 140;
    const now = Date.now();
    const threshold = 250 - proximity * 200;

    if (now - state.lastGeiger > threshold) {
      state.lastGeiger = now;
      spatialAudio.playGeigerClick(x, y);
    }

    if (msg.action === 'push') {
      spatialAudio.stopMicroTone();
      spatialAudio.playSuccess();
      cb.showFeedback('PUSH NOW');
    }
  } else if (msg.distance !== undefined && Number(msg.distance) > 0) {
    if (msg.target_detected) {
      spatialAudio.playTargetLocked();
    } else {
      spatialAudio.playSonar(msg.direction || 'ahead', Number(msg.distance), msg.priority || 'low');
    }
  }

  // 3. UI by type
  switch (msg.type) {
    case 'result':
      cb.updateNavUI(msg);
      break;
    case 'micro_result':
      cb.updateMicroUI(msg);
      break;
    case 'task_update':
      cb.updateTaskUI(msg);
      break;
    case 'inquiry_result':
      cb.updateInquiryUI(msg);
      break;
    case 'speak':
      if (msg.text) {
        if (msg.priority === 'critical' && !msg.audio) {
          // Critical-priority fallback when no Gnani audio is attached
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            try {
              const utter = new SpeechSynthesisUtterance(msg.text);
              if (msg.lang) {
                utter.lang = msg.lang;
              }
              window.speechSynthesis.speak(utter);
            } catch {}
          }
        } else {
          // Play Gnani WAV audio when present, with automatic speechSynthesis fallback
          audioQueue.play(msg.text, msg.audio, msg.lang);
        }
        cb.announce(msg.text);
      }
      break;
  }
}

// Fetch Helpers
export async function apiStartSession(
  sessionId: string
): Promise<{ messages: any[]; scanIntervalMs?: number; microIntervalMs?: number; quotaRpm?: number }> {
  const res = await fetch('/api/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    messages: data.messages || [],
    scanIntervalMs: data.scanIntervalMs,
    microIntervalMs: data.microIntervalMs,
    quotaRpm: data.quotaRpm,
  };
}

export async function apiSendFrame(
  sessionId: string,
  image: string,
  heading: number
): Promise<{
  messages: any[];
  skipped?: boolean;
  rate_limited?: boolean;
  rateLimited?: boolean;
  retryAfter?: number;
  is429?: boolean;
}> {
  const res = await fetch('/api/frame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, image, heading }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function apiSendInquiry(
  sessionId: string,
  image: string,
  audio: string,
  audioMime: string
): Promise<any[]> {
  const res = await fetch('/api/inquiry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, image, audio, audioMime }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

export async function apiEndSession(sessionId: string): Promise<void> {
  try {
    await fetch('/api/session/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch {}
}

export async function apiCheckHealth(): Promise<{
  ok: boolean;
  hasKey: boolean;
  hasGroqKey?: boolean;
  hasGnaniKey?: boolean;
}> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
