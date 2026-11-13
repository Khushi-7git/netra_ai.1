// NETRA Server (server.ts)
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { SessionState, globalTaskState } from './server/session.js';
import { SCAN_INTERVAL_MS, MICRO_INTERVAL_MS, QUOTA_RPM, GROQ_KEY, GNANI_KEY } from './server/config.js';
import {
  processNavFrame,
  processMicroFrame,
  processTaskFrame,
  processInquiry,
  getRateLimitStatus,
} from './server/processor.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;

// Section 1: Express JSON body limit must be raised
app.use(express.json({ limit: '15mb' }));

// In-memory sessions map
const sessions = new Map<string, SessionState>();

function getOrCreateSession(sessionId: string): SessionState {
  let session = sessions.get(sessionId);
  if (!session) {
    session = new SessionState(sessionId);
    sessions.set(sessionId, session);
  }
  return session;
}

// GET /api/health
app.get('/api/health', (_req: Request, res: Response) => {
  const hasGroq = Boolean(GROQ_KEY || process.env.GROQ_KEY);
  const hasGnani = Boolean(GNANI_KEY || process.env.GNANI_KEY);
  res.json({
    ok: true,
    hasKey: hasGroq,
    hasGroqKey: hasGroq,
    hasGnaniKey: hasGnani,
  });
});

// POST /api/session/start
app.post('/api/session/start', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }

    const session = getOrCreateSession(sessionId);

    // If global task state is valid (active and updated within 300 s), restore it
    if (globalTaskState.isValid()) {
      session.taskState = {
        isActive: globalTaskState.isActive,
        plan: JSON.parse(JSON.stringify(globalTaskState.plan)),
        currentStepIndex: globalTaskState.currentStepIndex,
      };
      session.mode = 'task';
      const curInstr =
        session.taskState.plan[session.taskState.currentStepIndex]?.instruction || '';

      return res.json({
        messages: [
          {
            type: 'task_update',
            plan: session.taskState.plan,
            current_step_index: session.taskState.currentStepIndex,
            restored: true,
          },
          {
            type: 'speak',
            text: `Resuming. Step: ${curInstr}`,
          },
        ],
        scanIntervalMs: SCAN_INTERVAL_MS,
        microIntervalMs: MICRO_INTERVAL_MS,
        quotaRpm: QUOTA_RPM,
      });
    }

    return res.json({
      messages: [],
      scanIntervalMs: SCAN_INTERVAL_MS,
      microIntervalMs: MICRO_INTERVAL_MS,
      quotaRpm: QUOTA_RPM,
    });
  } catch (err: any) {
    console.error('[NETRA:SessionStart Error]', err);
    return res.json({
      messages: [],
      scanIntervalMs: SCAN_INTERVAL_MS,
      microIntervalMs: MICRO_INTERVAL_MS,
      quotaRpm: QUOTA_RPM,
    });
  }
});

// POST /api/frame
app.post('/api/frame', async (req: Request, res: Response) => {
  try {
    const { sessionId, image, heading } = req.body || {};
    if (!sessionId || !image) {
      return res.json({ messages: [], skipped: true });
    }

    const session = getOrCreateSession(sessionId);

    // If already processing, skip immediately (frame-dropping)
    if (session.isProcessing) {
      session.framesSkipped++;
      return res.json({ messages: [], skipped: true });
    }

    session.isProcessing = true;
    session.framesReceived++;

    let frameResult: {
      messages: any[];
      rate_limited?: boolean;
      retryAfter?: number;
      is429?: boolean;
    } = { messages: [] };

    try {
      if (session.mode === 'micro') {
        frameResult = await processMicroFrame(session, image);
      } else if (session.mode === 'task') {
        frameResult = await processTaskFrame(session, image);
      } else {
        frameResult = await processNavFrame(session, image, Number(heading ?? 0));
      }
      session.framesProcessed++;
    } catch (procErr) {
      console.error('[NETRA:Frame Processing Error]', procErr);
      frameResult = { messages: [] };
    } finally {
      session.isProcessing = false;
    }

    const rateStatus = getRateLimitStatus();
    const isRateLimited = Boolean(frameResult.rate_limited || rateStatus.isRateLimited);
    const retryAfter = frameResult.retryAfter ?? rateStatus.retryAfter ?? 0;

    return res.json({
      messages: frameResult.messages || [],
      rate_limited: isRateLimited,
      rateLimited: isRateLimited,
      retryAfter,
      is429: Boolean(frameResult.is429),
    });
  } catch (err: any) {
    console.error('[NETRA:Frame Route Error]', err);
    return res.json({ messages: [] });
  }
});

// POST /api/inquiry
app.post('/api/inquiry', async (req: Request, res: Response) => {
  try {
    const { sessionId, image, audio, audioMime } = req.body || {};
    if (!sessionId) {
      return res.json({ messages: [{ type: 'speak', text: 'Session ID missing.' }] });
    }

    const session = getOrCreateSession(sessionId);
    const messages = await processInquiry(session, image || '', audio || '', audioMime || '');
    return res.json({ messages });
  } catch (err: any) {
    console.error('[NETRA:Inquiry Route Error]', err);
    return res.json({ messages: [{ type: 'speak', text: 'Sorry, I had an error processing that.' }] });
  }
});

// POST /api/session/end
app.post('/api/session/end', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body || {};
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (session.taskState && session.taskState.isActive) {
        globalTaskState.updateFrom(session.taskState);
      }
      sessions.delete(sessionId);
    }
    return res.json({ messages: [], ok: true });
  } catch (err: any) {
    console.error('[NETRA:SessionEnd Error]', err);
    return res.json({ messages: [], ok: false });
  }
});

// Mount Vite in dev, or serve dist in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NETRA] Server running on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[NETRA] Failed to start server:', err);
});
