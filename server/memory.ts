// NETRA Persistent Memory (Section 8)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEMORY_FILE =
  process.env.MEMORY_FILE_PATH || path.join(__dirname, '..', 'long_term_memory.json');

export interface LocationEntry {
  description: string;
  timestamp: number;
}

export interface HistoryEntry {
  object: string;
  location: string | null;
  scene: string;
  timestamp: number;
}

export interface MemoryData {
  locations: Record<string, LocationEntry>;
  history: HistoryEntry[];
}

export class PersistentMemory {
  data: MemoryData = {
    locations: {},
    history: [],
  };

  constructor() {
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = {
          locations: parsed.locations || {},
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    } catch {
      this.data = { locations: {}, history: [] };
    }
  }

  save(): void {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch {
      // Container may be read-only; keep working from memory
    }
  }

  addLocation(name: string, description: string): void {
    if (!name) return;
    this.data.locations[name] = {
      description: description || '',
      timestamp: Date.now(),
    };
    this.save();
  }

  getLocationSummary(): string {
    const entries = Object.entries(this.data.locations);
    if (entries.length === 0) {
      return 'No tagged locations yet.';
    }
    return entries.map(([k, v]) => `'${k}': ${v.description}`).join(', ');
  }

  logObject(name: string, locationTag: string | null, sceneDesc: string): void {
    if (!name) return;
    const clean = name.trim().toLowerCase();
    if (clean === 'none' || clean === 'unknown' || clean === 'null' || clean === '') {
      return;
    }

    const now = Date.now();
    const last = this.data.history[this.data.history.length - 1];
    if (last && last.object.toLowerCase() === clean && (now - last.timestamp) < 10000) {
      return; // Skip if same object under 10 s old
    }

    this.data.history.push({
      object: name.trim(),
      location: locationTag || null,
      scene: sceneDesc || '',
      timestamp: now,
    });

    if (this.data.history.length > 1000) {
      this.data.history = this.data.history.slice(-1000);
    }
    this.save();
  }

  getHistoryContext(): string {
    if (this.data.history.length === 0) {
      return 'No object history recorded.';
    }

    const last50 = this.data.history.slice(-50);
    return last50
      .map(entry => {
        const d = new Date(entry.timestamp);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const loc = entry.location ? ` at '${entry.location}'` : '';
        return `[${hh}:${mm}] Saw ${entry.object}${loc} (${entry.scene})`;
      })
      .join('\n');
  }
}

export const memory = new PersistentMemory();
