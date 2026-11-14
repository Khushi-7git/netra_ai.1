// NETRA Audio Engine (Section 11) - SpatialAudio Class

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function parseDir(dirStr: string = ''): number {
  const lower = dirStr.toLowerCase();
  if (lower.includes('left')) return -45;
  if (lower.includes('right')) return 45;
  return 0;
}

export class SpatialAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  private isPlayingMicro: boolean = false;
  private microOsc: OscillatorNode | null = null;
  private microPanner: StereoPannerNode | null = null;
  private microGain: GainNode | null = null;

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    this.ctx = new AudioContextClass();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  private ensureContext(): AudioContext | null {
    if (!this.ctx) {
      this.init();
    } else if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playTone(freq: number, type: OscillatorType, dur: number): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + dur);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + dur);
  }

  startMicroTone(): void {
    if (this.isPlayingMicro) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    this.isPlayingMicro = true;
    const now = ctx.currentTime;

    this.microOsc = ctx.createOscillator();
    this.microOsc.type = 'triangle';
    this.microOsc.frequency.setValueAtTime(440, now);

    if (typeof ctx.createStereoPanner === 'function') {
      this.microPanner = ctx.createStereoPanner();
      this.microPanner.pan.setValueAtTime(0, now);
    }

    this.microGain = ctx.createGain();
    this.microGain.gain.setValueAtTime(0, now);
    this.microGain.gain.linearRampToValueAtTime(0.2, now + 0.5);

    if (this.microPanner) {
      this.microOsc.connect(this.microPanner);
      this.microPanner.connect(this.microGain);
    } else {
      this.microOsc.connect(this.microGain);
    }
    this.microGain.connect(this.masterGain);

    this.microOsc.start(now);
  }

  updateMicroTone(x: number, y: number): void {
    if (!this.isPlayingMicro || !this.ctx) return;
    const now = this.ctx.currentTime;

    const panVal = clamp(x / 20, -1, 1);
    if (this.microPanner) {
      this.microPanner.pan.setTargetAtTime(panVal, now, 0.1);
    }

    const freqVal = clamp(440 + (y / 20) * 200, 100, 1000);
    if (this.microOsc) {
      this.microOsc.frequency.setTargetAtTime(freqVal, now, 0.1);
    }
  }

  stopMicroTone(): void {
    if (!this.isPlayingMicro || !this.ctx) return;
    const now = this.ctx.currentTime;

    if (this.microGain) {
      this.microGain.gain.linearRampToValueAtTime(0.001, now + 0.2);
    }
    if (this.microOsc) {
      this.microOsc.stop(now + 0.2);
    }

    setTimeout(() => {
      this.microOsc?.disconnect();
      this.microPanner?.disconnect();
      this.microGain?.disconnect();
      this.microOsc = null;
      this.microPanner = null;
      this.microGain = null;
      this.isPlayingMicro = false;
    }, 250);
  }

  playSonar(dir: string, dist: number, prio: string): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const panDeg = parseDir(dir);
    const panVal = Math.sin((panDeg * Math.PI) / 180);
    const freq = (prio || '').toLowerCase() === 'critical' ? 880 : 440;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(panVal, now);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      osc.connect(gain);
      gain.connect(this.masterGain);
    }

    osc.start(now);
    osc.stop(now + 0.2);
  }

  playTargetLocked(): void {
    this.playTone(1200, 'square', 0.1);
  }

  playSuccess(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    // C5 523.25 Hz sine 0.2s
    // E5 659.25 Hz at +100ms (0.2s)
    // G5 783.99 Hz at +200ms (0.4s)
    const notes = [
      { freq: 523.25, start: 0, dur: 0.2 },
      { freq: 659.25, start: 0.1, dur: 0.2 },
      { freq: 783.99, start: 0.2, dur: 0.4 },
    ];

    const baseTime = ctx.currentTime;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, baseTime + note.start);

      gain.gain.setValueAtTime(0.25, baseTime + note.start);
      gain.gain.exponentialRampToValueAtTime(0.01, baseTime + note.start + note.dur);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start(baseTime + note.start);
      osc.stop(baseTime + note.start + note.dur);
    }
  }

  playGeigerClick(x: number, y: number): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const dist = Math.sqrt(x * x + y * y);
    const proximity = 1 - Math.min(dist, 140) / 140;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1000 + proximity * 800, now);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.05);
  }
}

export const spatialAudio = new SpatialAudio();

/**
 * Single-queue audio player for synthetic WAV playback with automatic
 * speechSynthesis fallback and cancellation support.
 */
export class AudioPlayerQueue {
  private queue: Array<{ audioB64?: string; text: string; lang?: string }> = [];
  private currentAudio: HTMLAudioElement | null = null;
  private isPlaying: boolean = false;

  play(text: string, audioB64?: string, lang?: string): void {
    if (!text && !audioB64) return;
    this.queue.push({ text, audioB64, lang });
    if (!this.isPlaying) {
      this.playNext();
    }
  }

  private playNext(): void {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentAudio = null;
      return;
    }

    this.isPlaying = true;
    const item = this.queue.shift()!;

    if (item.audioB64) {
      try {
        const audio = new Audio(`data:audio/wav;base64,${item.audioB64}`);
        this.currentAudio = audio;

        let handled = false;
        const fallback = () => {
          if (handled) return;
          handled = true;
          this.currentAudio = null;
          this.speakNative(item.text, () => this.playNext(), item.lang);
        };

        audio.onended = () => {
          if (handled) return;
          handled = true;
          this.currentAudio = null;
          this.playNext();
        };

        audio.onerror = () => {
          fallback();
        };

        audio.play().catch(() => {
          fallback();
        });
      } catch {
        this.speakNative(item.text, () => this.playNext(), item.lang);
      }
    } else {
      this.speakNative(item.text, () => this.playNext(), item.lang);
    }
  }

  private speakNative(text: string, onEnd: () => void, lang?: string): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && text) {
      try {
        const utter = new SpeechSynthesisUtterance(text);
        if (lang) {
          utter.lang = lang;
        }
        utter.onend = () => onEnd();
        utter.onerror = () => onEnd();
        window.speechSynthesis.speak(utter);
      } catch {
        onEnd();
      }
    } else {
      onEnd();
    }
  }

  cancel(): void {
    this.queue = [];
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch {}
      this.currentAudio = null;
    }
    this.isPlaying = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }
}

export const audioQueue = new AudioPlayerQueue();

