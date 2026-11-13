// NETRA Speech Manager (Section 6)
import { SPEECH_INTERVALS } from './config.js';

const STOP_WORDS = new Set([
  'grey', 'gray', 'white', 'black', 'brown', 'red', 'blue', 'green',
  'open', 'closed', 'small', 'large', 'big', 'little', 'tiny', 'huge',
  'old', 'new', 'patterned', 'textured', 'wooden', 'metal'
]);

export function priorityValue(priority: string): number {
  switch (priority?.toLowerCase()) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    case 'info': return 0;
    default: return 0;
  }
}

export class SpeechManager {
  currentSpeechEndTime: number = 0;
  lastSemanticKey: string = '';
  lastSpeechTime: number = 0;
  lastDistance: number = 999;
  lastPriority: string = 'low';
  announcedSubjects: Map<string, number> = new Map();
  recentSpeeches: string[] = [];

  semanticKey(subject: string, direction: string, category: string): string {
    const raw = (subject || '').toLowerCase().trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const filtered = parts.filter(w => !STOP_WORDS.has(w));
    const core = filtered.length > 0 ? filtered.join(' ') : raw;
    return `${core}|${direction || 'ahead'}|${category || 'unknown'}`;
  }

  shouldSpeak(
    priority: string,
    subject: string,
    direction: string,
    category: string,
    distance: number,
    now: number = Date.now() / 1000
  ): [boolean, string] {
    const prio = (priority || 'low').toLowerCase();

    // 1. Critical priority always speaks
    if (prio === 'critical') {
      return [true, 'critical_alert'];
    }

    // 2. If still speaking
    if (now < this.currentSpeechEndTime) {
      if (priorityValue(prio) > priorityValue(this.lastPriority) && distance < (this.lastDistance - 0.3)) {
        return [true, 'priority_escalation'];
      }
      return [false, 'speech_in_progress'];
    }

    const key = this.semanticKey(subject, direction, category);

    // 3. Same semantic key
    if (key === this.lastSemanticKey) {
      if (this.lastDistance - distance > 0.5) {
        return [true, 'distance_closed'];
      }
      const interval = SPEECH_INTERVALS[prio] ?? SPEECH_INTERVALS.medium;
      if (now - this.lastSpeechTime < interval) {
        return [false, 'same_context_cooldown'];
      }
      return [true, 'interval_passed'];
    }

    // 4. New context
    if (now - this.lastSpeechTime < 3.0) {
      return [false, 'global_cooldown'];
    }

    const subKey = (subject || '').toLowerCase().trim();
    if (subKey) {
      const announcedTs = this.announcedSubjects.get(subKey);
      if (announcedTs !== undefined && (now - announcedTs) < 10) {
        return [false, 'subject_recently_announced'];
      }
    }

    return [true, 'new_context'];
  }

  recordSpeech(
    text: string,
    priority: string,
    subject: string,
    direction: string,
    category: string,
    distance: number,
    now: number = Date.now() / 1000
  ): void {
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    this.currentSpeechEndTime = now + (words / 2.5 + 0.5);
    this.lastSemanticKey = this.semanticKey(subject, direction, category);
    this.lastSpeechTime = now;
    this.lastDistance = distance;
    this.lastPriority = (priority || 'low').toLowerCase();

    const subKey = (subject || '').toLowerCase().trim();
    if (subKey) {
      this.announcedSubjects.set(subKey, now);
    }

    this.recentSpeeches.push(text);
    if (this.recentSpeeches.length > 5) {
      this.recentSpeeches.shift();
    }

    // Drop announced subjects older than 60s
    for (const [k, ts] of this.announcedSubjects.entries()) {
      if (now - ts > 60) {
        this.announcedSubjects.delete(k);
      }
    }
  }
}
