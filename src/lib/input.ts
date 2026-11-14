// NETRA Input Handler (Section 10.6 & 10.7)
import { spatialAudio } from './audio';

export interface InputHandlers {
  onToggleSystem: () => void;
  onToggleIntel: () => void;
  onToggleConsole: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onHeadingChange: (heading: number) => void;
}

export function setupInputListeners(
  hudContainer: HTMLElement | null,
  handlers: InputHandlers
): () => void {
  let lastTouchEndTime = 0;
  let lastShakeTime = 0;

  // Touch handlers
  const handleTouchStart = (e: TouchEvent) => {
    // 3-finger touch toggles debug console
    if (e.touches.length === 3) {
      handlers.onToggleConsole();
      return;
    }

    // Ignore touches inside interactive buttons or intelligence layer
    const target = e.target as HTMLElement | null;
    if (
      target?.closest('button, #micQueryBtn, #startBtn, #intelligence-layer.visible, #console-log')
    ) {
      return;
    }

    // Check double-tap to start/stop
    const now = Date.now();
    if (e.touches.length === 1) {
      if (now - lastTouchEndTime < 300) {
        handlers.onToggleSystem();
        lastTouchEndTime = 0;
        return;
      }
      lastTouchEndTime = now;
    }
  };

  // Shake detection
  const handleDeviceMotion = (e: DeviceMotionEvent) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    const mag = Math.sqrt(x * x + y * y + z * z);
    const delta = Math.abs(mag - 9.8);

    const now = Date.now();
    if (delta > 20 && now - lastShakeTime > 1000) {
      lastShakeTime = now;
      handlers.onToggleIntel();
    }
  };

  // Compass / heading
  const handleDeviceOrientation = (e: DeviceOrientationEvent) => {
    let heading = 0;
    if ((e as any).webkitCompassHeading !== undefined) {
      heading = (e as any).webkitCompassHeading;
    } else if (e.alpha !== null && e.alpha !== undefined) {
      heading = (360 - e.alpha) % 360;
    }
    handlers.onHeadingChange(Math.round(heading));
  };

  const handleDblClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target?.closest('button, #micQueryBtn, #startBtn, #intelligence-layer.visible, #console-log')
    ) {
      return;
    }
    handlers.onToggleSystem();
  };

  // Keyboard fallbacks
  let isSpacePressed = false;
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === 'Enter') {
      handlers.onToggleSystem();
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (!isSpacePressed) {
        isSpacePressed = true;
        handlers.onStartRecording();
      }
    } else if (e.key === 'i' || e.key === 'I') {
      handlers.onToggleIntel();
    } else if (e.key === 'd' || e.key === 'D') {
      handlers.onToggleConsole();
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (isSpacePressed) {
        isSpacePressed = false;
        handlers.onStopRecording();
      }
    }
  };

  window.addEventListener('touchstart', handleTouchStart, { passive: true });
  window.addEventListener('devicemotion', handleDeviceMotion);
  window.addEventListener('deviceorientation', handleDeviceOrientation);

  window.addEventListener('dblclick', handleDblClick);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  return () => {
    window.removeEventListener('touchstart', handleTouchStart);
    window.removeEventListener('devicemotion', handleDeviceMotion);
    window.removeEventListener('deviceorientation', handleDeviceOrientation);

    window.removeEventListener('dblclick', handleDblClick);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
  };
}

// Helper: Encode 16kHz mono Float32Array to 16-bit PCM WAV ArrayBuffer
function encodeWav16BitMono(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF header
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');

  // fmt chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1 size
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, 1, true); // channels (1 = mono)
  view.setUint32(24, sampleRate, true); // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * 1 * 2)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // PCM 16-bit samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const pcm16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, pcm16, true);
  }

  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 8192) {
    const chunk = bytes.subarray(i, Math.min(i + 8192, len));
    binary += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binary);
}

export async function convertBlobToWav16kMono(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextClass =
    window.AudioContext || (window as any).webkitAudioContext;
  const tempCtx = new AudioContextClass();

  let decodedBuffer: AudioBuffer;
  try {
    decodedBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  } finally {
    tempCtx.close().catch(() => {});
  }

  const targetSampleRate = 16000;
  const targetLength = Math.max(1, Math.ceil(decodedBuffer.duration * targetSampleRate));
  const offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = decodedBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  const channelData = renderedBuffer.getChannelData(0);

  const wavArrayBuffer = encodeWav16BitMono(channelData, targetSampleRate);
  return arrayBufferToBase64(wavArrayBuffer);
}

// Media Recording helper (16 kHz mono 16-bit PCM WAV for Gnani Vachana STT)
export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startTime: number = 0;
  private mimeType: string = '';
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;

  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording';
  }

  async start(onAutoStop?: () => void): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return false; // Mic blocked
    }

    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
    ];

    this.mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, options);
    } catch {
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.audioChunks = [];
    this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        this.audioChunks.push(e.data);
      }
    };

    this.startTime = Date.now();
    this.mediaRecorder.start();

    // Automatically stop recording at 29s (Gnani's limit is 30s)
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
    }
    this.autoStopTimer = setTimeout(() => {
      if (this.isRecording() && onAutoStop) {
        onAutoStop();
      }
    }, 29000);

    return true;
  }

  stop(): Promise<{ base64: string; mimeType: string; duration: number } | null> {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
        this.cleanUpStream();
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = async () => {
        const duration = Date.now() - this.startTime;
        this.cleanUpStream();

        if (duration < 300) {
          resolve(null); // Ignore short holds under 300 ms
          return;
        }

        try {
          const blob = new Blob(this.audioChunks, {
            type: this.mimeType || 'audio/webm',
          });

          // Resample to 16 kHz mono 16-bit PCM WAV
          const wavBase64 = await convertBlobToWav16kMono(blob);
          resolve({
            base64: wavBase64,
            mimeType: 'audio/wav',
            duration,
          });
        } catch (err) {
          console.warn('[NETRA] Audio conversion to 16kHz WAV failed:', err);
          resolve(null);
        }
      };

      try {
        this.mediaRecorder.stop();
      } catch {
        this.cleanUpStream();
        resolve(null);
      }
    });
  }

  private cleanUpStream() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }
}

