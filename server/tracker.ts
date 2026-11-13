// NETRA Visual Tracker (Section 7)

export interface DetectionInput {
  name?: string;
  confidence_score?: number;
  distance?: number;
  direction?: string;
  category?: string;
  risk_level?: string;
}

export interface TrackedObject {
  name: string;
  distance: number;
  rawDistance: number;
  direction: string;
  confidence: number;
  category: string;
  lastSeen: number;
  framesDetected: number;
  isStable: boolean;
}

export class VisualTracker {
  trackedObjects: Map<string, TrackedObject> = new Map();

  processDetections(
    detections: DetectionInput[] = [],
    now: number = Date.now() / 1000
  ): TrackedObject[] {
    // 1. Drop tracked objects with now - lastSeen >= 2 s
    for (const [key, obj] of this.trackedObjects.entries()) {
      if (now - obj.lastSeen >= 2.0) {
        this.trackedObjects.delete(key);
      }
    }

    // 2. Process each detection
    for (const det of detections) {
      if (!det || !det.name) continue;
      const conf = det.confidence_score !== undefined ? Number(det.confidence_score) : 100;
      if (conf < 75) continue;

      const key = det.name.toLowerCase().trim();
      const d = Number(det.distance ?? 0);
      const dir = det.direction ?? 'ahead';
      const cat = det.category ?? 'unknown';

      const existing = this.trackedObjects.get(key);
      if (existing) {
        existing.lastSeen = now;
        existing.framesDetected++;
        existing.rawDistance = d;
        existing.distance = existing.distance * 0.7 + d * 0.3;
        existing.direction = dir;
        existing.confidence = conf;
        existing.category = cat;
        if (existing.framesDetected >= 2) {
          existing.isStable = true;
        }
      } else {
        this.trackedObjects.set(key, {
          name: det.name,
          distance: d,
          rawDistance: d,
          direction: dir,
          confidence: conf,
          category: cat,
          lastSeen: now,
          framesDetected: 1,
          isStable: false,
        });
      }
    }

    // 4. Return only isStable objects
    const stable: TrackedObject[] = [];
    for (const obj of this.trackedObjects.values()) {
      if (obj.isStable) {
        stable.push(obj);
      }
    }
    return stable;
  }
}
