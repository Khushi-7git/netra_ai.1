// NETRA Session State & Global Task State (Section 5)
import { SpeechManager } from './speech.js';
import { VisualTracker } from './tracker.js';

export interface TaskStep {
  step_id: number;
  instruction: string;
  items?: string[];
  completed: boolean;
}

export interface TaskState {
  isActive: boolean;
  plan: TaskStep[];
  currentStepIndex: number;
}

export interface MemoryObject {
  timestamp: number;
  direction: string;
  distance: number;
  category: string;
}

export class GlobalTaskState {
  isActive: boolean = false;
  plan: TaskStep[] = [];
  currentStepIndex: number = 0;
  taskName: string = '';
  lastUpdated: number = 0;

  isValid(now: number = Date.now()): boolean {
    return this.isActive && (now - this.lastUpdated) < 300000; // 300 s
  }

  updateFrom(taskState: TaskState, taskName?: string, now: number = Date.now()): void {
    this.isActive = taskState.isActive;
    this.plan = JSON.parse(JSON.stringify(taskState.plan || []));
    this.currentStepIndex = taskState.currentStepIndex;
    if (taskName !== undefined) {
      this.taskName = taskName;
    }
    this.lastUpdated = now;
  }
}

export const globalTaskState = new GlobalTaskState();

export class SessionState {
  sessionId: string;
  recentSpeeches: string[] = [];
  socialContext: string[] = []; // max 5, drop oldest
  framesReceived: number = 0;
  framesProcessed: number = 0;
  framesSkipped: number = 0;
  currentGoal: string | null = null;
  microTarget: string | null = null;
  mode: 'nav' | 'micro' | 'task' = 'nav';
  language: string = 'en-IN';
  objectMemory: Map<string, MemoryObject> = new Map();
  taskState: TaskState = {
    isActive: false,
    plan: [],
    currentStepIndex: 0,
  };
  isProcessing: boolean = false;
  speechManager: SpeechManager;
  tracker: VisualTracker;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.speechManager = new SpeechManager();
    this.tracker = new VisualTracker();
  }

  updateMemory(subject: string, direction: string, distance: number, category: string, now: number = Date.now()): void {
    if (!subject) return;
    const key = subject.toLowerCase().trim();
    this.objectMemory.set(key, {
      timestamp: now,
      direction: direction || 'ahead',
      distance: Number(distance ?? 0),
      category: category || 'unknown',
    });

    // Prune entries older than 30 s
    for (const [k, obj] of this.objectMemory.entries()) {
      if (now - obj.timestamp > 30000) {
        this.objectMemory.delete(k);
      }
    }
  }

  getMemoryContext(now: number = Date.now()): string {
    if (this.objectMemory.size === 0) {
      return 'No objects in memory.';
    }

    const entries: string[] = [];
    for (const [name, obj] of this.objectMemory.entries()) {
      const ageSeconds = Math.round((now - obj.timestamp) / 1000);
      entries.push(`${name} (${obj.direction}, ${obj.distance.toFixed(1)}m, ${ageSeconds}s ago)`);
    }

    return `Objects in memory: ${entries.join(', ')}`;
  }
}
