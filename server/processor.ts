// NETRA Processors (server/processor.ts) with Groq & Gnani Vachana
import {
  AI_PROMPT,
  MICRO_NAV_PROMPT,
  INQUIRY_PROMPT,
  TASK_PLANNER_PROMPT,
  TASK_GUIDANCE_PROMPT,
} from './prompts.js';
import { SessionState, globalTaskState, TaskStep } from './session.js';
import { memory } from './memory.js';
import {
  askJson,
  getGlobalRateLimitStatus,
  cleanAndParseJson,
} from './llm.js';
import { transcribe, synthesize } from './gnani.js';
import { GNANI_TTS_MODE } from './config.js';

export const parseModelJson = cleanAndParseJson;

export function getRateLimitStatus(now: number = Date.now()): {
  isRateLimited: boolean;
  retryAfter: number;
} {
  return getGlobalRateLimitStatus(now);
}

export function formatDistanceSpeech(m: number): string {
  if (m < 1.0) {
    return `${Math.round(m * 100)} centimeters`;
  } else if (m < 10.0) {
    return `${m.toFixed(1)} meters`;
  } else {
    return `${Math.round(m)} meters`;
  }
}

/**
 * Builds a speak message, calling synthesize() when enabled by GNANI_TTS_MODE.
 * Critical alerts bypass TTS to guarantee instant playback.
 */
export async function buildSpeakMessage(
  text: string,
  source: 'inquiry' | 'frame',
  priority?: string
): Promise<{ type: 'speak'; text: string; audio?: string; priority?: string }> {
  const msg: { type: 'speak'; text: string; audio?: string; priority?: string } = {
    type: 'speak',
    text,
  };
  if (priority) {
    msg.priority = priority;
  }

  const shouldSynthesize =
    GNANI_TTS_MODE === 'all' ||
    (GNANI_TTS_MODE === 'inquiry' && source === 'inquiry');

  // Critical alerts must always use client speechSynthesis for zero latency
  if (shouldSynthesize && priority !== 'critical') {
    try {
      const audioBase64 = await synthesize(text);
      if (audioBase64) {
        msg.audio = audioBase64;
      }
    } catch {
      // Never block on TTS failure; send message without audio
    }
  }

  return msg;
}

// 9.1 Navigation frame
export async function processNavFrame(
  session: SessionState,
  imageBase64: string,
  heading: number
): Promise<{ messages: any[]; rate_limited?: boolean; retryAfter?: number; is429?: boolean }> {
  const startTime = Date.now();

  // Rate limit cooldown check
  const rateStatus = getGlobalRateLimitStatus();
  if (rateStatus.isRateLimited) {
    return {
      messages: [],
      rate_limited: true,
      retryAfter: rateStatus.retryAfter,
    };
  }

  const task = session.currentGoal
    ? `SEARCHING FOR: ${session.currentGoal}`
    : 'General Guidance';

  const temporal_context =
    session.socialContext.length > 0
      ? session.socialContext.slice(-3).join(' | ')
      : 'None';

  const headingRounded = Math.round(heading || 0).toString();
  const promptText = AI_PROMPT
    .replaceAll('{heading}', headingRounded)
    .replaceAll('{task}', task)
    .replaceAll('{temporal_context}', temporal_context)
    .replaceAll('{memory}', session.getMemoryContext())
    .replaceAll('{known_locations}', memory.getLocationSummary());

  const result = await askJson(promptText, imageBase64, 0.3);

  if (!result) {
    const afterStatus = getGlobalRateLimitStatus();
    if (afterStatus.isRateLimited) {
      return {
        messages: [],
        rate_limited: true,
        retryAfter: afterStatus.retryAfter,
        is429: true,
      };
    }
    return { messages: [] };
  }

  const priority = (result.priority || 'low').toLowerCase();
  const category = (result.category || 'navigation').toLowerCase();
  const subject = result.subject || '';
  const distance =
    typeof result.distance === 'number'
      ? result.distance
      : parseFloat(result.distance) || 2.0;
  const direction = result.direction || 'ahead';
  let speech = result.speech || '';
  const sceneDescription = result.scene_description || '';
  const targetDetected = Boolean(result.target_detected);
  const currentLocationTag = result.current_location_tag || null;

  // Update session socialContext and memory
  if (sceneDescription) {
    session.socialContext.push(sceneDescription);
    if (session.socialContext.length > 5) {
      session.socialContext.shift();
    }
  }

  const loggedCategories = ['target', 'social', 'text', 'furniture'];
  if (subject && loggedCategories.includes(category)) {
    memory.logObject(subject, currentLocationTag, sceneDescription);
  }
  if (subject) {
    session.updateMemory(subject, direction, distance, category);
  }

  // Append distance to speech if needed
  if (speech && distance > 0) {
    const truncStr = String(Math.trunc(distance));
    if (!speech.includes(truncStr)) {
      speech = `${speech} ${formatDistanceSpeech(distance)} away.`;
    }
  }

  // Speech check
  const [shouldSpeak, reason] = session.speechManager.shouldSpeak(
    priority,
    subject,
    direction,
    category,
    distance
  );

  const messages: any[] = [];
  let spoke = false;
  if (shouldSpeak && speech) {
    session.speechManager.recordSpeech(
      speech,
      priority,
      subject,
      direction,
      category,
      distance
    );
    const speakMsg = await buildSpeakMessage(speech, 'frame', priority);
    messages.push(speakMsg);
    spoke = true;
  }

  // Visual tracker
  const rawObjects = Array.isArray(result.objects) ? result.objects : [];
  const stable = session.tracker.processDetections(rawObjects);
  const uiObjects =
    stable.length > 0
      ? stable.map((o) => ({ name: o.name, distance: o.distance, category: o.category }))
      : rawObjects.slice(0, 5).map((o: any) => ({
          name: o.name || 'Object',
          distance: Number(o.distance ?? 0),
          category: o.category ?? 'unknown',
        }));

  const elapsed = Date.now() - startTime;

  // Result message
  messages.push({
    type: 'result',
    priority,
    distance,
    direction,
    target_detected: targetDetected,
    current_goal: session.currentGoal,
    social_cues: result.social_cues || null,
    environment: result.environment || null,
    objects: uiObjects,
    scene: sceneDescription,
    ms: elapsed,
    stats: {
      received: session.framesReceived,
      processed: session.framesProcessed,
    },
    thinking: result.thinking || '',
  });

  console.log(
    `[NETRA:Frame] priority=${priority} scene="${sceneDescription.slice(0, 30)}" dist=${distance.toFixed(1)}m ` +
    `speech="${speech.slice(0, 30)}" ${spoke ? 'SPOKE' : `SKIPPED (${reason})`} ${elapsed}ms`
  );

  return { messages };
}

// 9.2 Micro-navigation frame
export async function processMicroFrame(
  session: SessionState,
  imageBase64: string
): Promise<{ messages: any[]; rate_limited?: boolean; retryAfter?: number; is429?: boolean }> {
  const startTime = Date.now();
  if (!session.microTarget) {
    return { messages: [] };
  }

  const rateStatus = getGlobalRateLimitStatus();
  if (rateStatus.isRateLimited) {
    return {
      messages: [],
      rate_limited: true,
      retryAfter: rateStatus.retryAfter,
    };
  }

  const promptText = MICRO_NAV_PROMPT.replaceAll('{target}', session.microTarget);
  const result = await askJson(promptText, imageBase64, 0.1);

  if (!result) {
    const afterStatus = getGlobalRateLimitStatus();
    if (afterStatus.isRateLimited) {
      return {
        messages: [{ type: 'speak', text: 'Rate limit reached. Please hold steady.' }],
        rate_limited: true,
        retryAfter: afterStatus.retryAfter,
        is429: true,
      };
    }
    return { messages: [] };
  }

  const elapsed = Date.now() - startTime;
  const messages: any[] = [
    {
      type: 'micro_result',
      x: result.x ?? 0,
      y: result.y ?? 0,
      action: result.action ?? 'move',
      guidance_speech: result.guidance_speech ?? null,
      ms: elapsed,
    },
  ];

  if (result.guidance_speech) {
    const speakMsg = await buildSpeakMessage(result.guidance_speech, 'frame');
    messages.push(speakMsg);
  }

  return { messages };
}

// 9.3 Task frame
export async function processTaskFrame(
  session: SessionState,
  imageBase64: string
): Promise<{ messages: any[]; rate_limited?: boolean; retryAfter?: number; is429?: boolean }> {
  const startTime = Date.now();
  if (!session.taskState.isActive || !session.taskState.plan || session.taskState.plan.length === 0) {
    session.mode = 'nav';
    return { messages: [] };
  }

  if (session.taskState.currentStepIndex >= session.taskState.plan.length) {
    session.taskState.isActive = false;
    session.taskState.plan = [];
    session.taskState.currentStepIndex = 0;
    session.mode = 'nav';
    const speakMsg = await buildSpeakMessage('Task already completed.', 'frame');
    return { messages: [speakMsg] };
  }

  const rateStatus = getGlobalRateLimitStatus();
  if (rateStatus.isRateLimited) {
    return {
      messages: [],
      rate_limited: true,
      retryAfter: rateStatus.retryAfter,
    };
  }

  const currentStep = session.taskState.plan[session.taskState.currentStepIndex];
  const promptText = TASK_GUIDANCE_PROMPT.replaceAll('{current_step}', currentStep.instruction);

  const result = await askJson(promptText, imageBase64, 0.1);

  if (!result) {
    const afterStatus = getGlobalRateLimitStatus();
    if (afterStatus.isRateLimited) {
      return {
        messages: [],
        rate_limited: true,
        retryAfter: afterStatus.retryAfter,
        is429: true,
      };
    }
    return { messages: [] };
  }

  const messages: any[] = [];
  if (result.step_completed) {
    currentStep.completed = true;
    session.taskState.currentStepIndex++;
    if (session.taskState.currentStepIndex >= session.taskState.plan.length) {
      const speakMsg = await buildSpeakMessage('Task completed! Great job.', 'frame');
      messages.push(speakMsg);
      session.taskState.isActive = false;
      session.mode = 'nav';
    } else {
      const nextInstr = session.taskState.plan[session.taskState.currentStepIndex].instruction;
      const speakMsg = await buildSpeakMessage(`Step done. Next: ${nextInstr}`, 'frame');
      messages.push(speakMsg);
    }
  } else if (result.speech) {
    const [shouldSpeak] = session.speechManager.shouldSpeak(
      'medium',
      'task',
      'guidance',
      'task',
      1.0
    );
    if (shouldSpeak) {
      session.speechManager.recordSpeech(result.speech, 'medium', 'task', 'guidance', 'task', 1.0);
      const speakMsg = await buildSpeakMessage(result.speech, 'frame', 'medium');
      messages.push(speakMsg);
    }
  }

  // Always update global task state
  globalTaskState.updateFrom(session.taskState);

  const elapsed = Date.now() - startTime;
  messages.push({
    type: 'task_update',
    plan: session.taskState.plan,
    current_step_index: session.taskState.currentStepIndex,
    visual_feedback: result.visual_feedback || '',
    ms: elapsed,
  });

  return { messages };
}

// 9.4 Inquiry (voice question)
export async function processInquiry(
  session: SessionState,
  imageBase64: string,
  audioBase64: string,
  _audioMime: string
): Promise<any[]> {
  const startTime = Date.now();

  // Voice inquiries ignore the frame cooldown
  let userText = '';
  if (audioBase64 && typeof audioBase64 === 'string' && audioBase64.trim().length > 0) {
    try {
      const wavBuffer = Buffer.from(audioBase64, 'base64');
      userText = await transcribe(wavBuffer);
    } catch (sttErr) {
      console.warn('[NETRA:Inquiry] STT failure:', sttErr);
      userText = '';
    }
  }

  // If transcription is empty, return "I didn't catch that."
  if (!userText || !userText.trim()) {
    return [{ type: 'speak', text: "I didn't catch that." }];
  }

  const task_str = session.taskState.isActive
    ? `ACTIVE TASK: Step ${session.taskState.currentStepIndex + 1}/${session.taskState.plan.length} - '${session.taskState.plan[session.taskState.currentStepIndex]?.instruction || 'Complete'}'`
    : 'No active task';

  const promptText = INQUIRY_PROMPT
    .replaceAll('{history_context}', memory.getHistoryContext())
    .replaceAll('{task_state}', task_str)
    .replaceAll('{user_text}', userText.trim());

  // Call Groq with prompt and image only (no audio part)
  const result = await askJson(promptText, imageBase64 || undefined, 0.3);

  if (!result) {
    const status = getGlobalRateLimitStatus();
    if (status.isRateLimited) {
      return [{ type: 'speak', text: 'Service is busy, please try again.' }];
    }
    return [{ type: 'speak', text: 'Sorry, I had an error processing that.' }];
  }

  const intent = result.intent || 'info';
  let speech = result.speech || "I didn't catch that.";
  const thinking = result.thinking || '';

  // Call handleIntent exactly ONCE per inquiry
  const { overrideSpeech, taskMessages } = await handleIntent(intent, result, session);
  if (typeof overrideSpeech === 'string') {
    speech = overrideSpeech;
  }

  const elapsed = Date.now() - startTime;
  const finalMessages: any[] = [];

  // Return task_update messages produced by handler (if any)
  if (taskMessages && taskMessages.length > 0) {
    finalMessages.push(...taskMessages);
  }

  // inquiry_result
  finalMessages.push({
    type: 'inquiry_result',
    thinking,
    current_goal: session.currentGoal,
    mode: session.mode,
    task_active: session.taskState.isActive,
    ms: elapsed,
  });

  // speak (with optional Gnani TTS synthesis)
  const speakMsg = await buildSpeakMessage(speech, 'inquiry');
  finalMessages.push(speakMsg);

  return finalMessages;
}

export async function handleIntent(
  intent: string,
  result: any,
  session: SessionState
): Promise<{ overrideSpeech: string | null; taskMessages: any[] }> {
  const taskMessages: any[] = [];

  switch (intent) {
    case 'micro_nav': {
      if (result.target) {
        session.mode = 'micro';
        session.microTarget = result.target;
        return {
          overrideSpeech: `Guiding you to the ${result.target}. Hold steady.`,
          taskMessages,
        };
      }
      return { overrideSpeech: null, taskMessages };
    }

    case 'search': {
      session.mode = 'nav';
      const goal = result.search_target || result.goal;
      if (goal) {
        session.currentGoal = goal;
        return {
          overrideSpeech: `Okay, searching for ${goal}.`,
          taskMessages,
        };
      }
      return { overrideSpeech: null, taskMessages };
    }

    case 'stop': {
      session.mode = 'nav';
      session.currentGoal = null;
      session.microTarget = null;
      session.taskState = { isActive: false, plan: [], currentStepIndex: 0 };
      globalTaskState.isActive = false;
      return {
        overrideSpeech: 'Stopping all tasks and searches.',
        taskMessages,
      };
    }

    case 'tag': {
      if (result.tag_name && result.scene_description) {
        memory.addLocation(result.tag_name, result.scene_description);
        return {
          overrideSpeech: `Tagged location as ${result.tag_name}.`,
          taskMessages,
        };
      }
      return { overrideSpeech: null, taskMessages };
    }

    case 'task': {
      if (!result.task_name) {
        return { overrideSpeech: "I didn't hear a task name.", taskMessages };
      }

      try {
        const memContext = `${memory.getHistoryContext()}\nLocations: ${memory.getLocationSummary()}`;
        const plannerPrompt = TASK_PLANNER_PROMPT
          .replaceAll('{user_query}', result.task_name)
          .replaceAll('{memory_context}', memContext);

        const plannerRes = await askJson(plannerPrompt, undefined, 0.3);

        let planArray: any = plannerRes;
        if (planArray && typeof planArray === 'object' && !Array.isArray(planArray)) {
          if (Array.isArray(planArray.steps)) {
            planArray = planArray.steps;
          } else if (Array.isArray(planArray.plan)) {
            planArray = planArray.plan;
          }
        }

        if (Array.isArray(planArray) && planArray.length > 0) {
          const parsedPlan: TaskStep[] = planArray.map((p, idx) => ({
            step_id: p.step_id || idx + 1,
            instruction: p.instruction || `Step ${idx + 1}`,
            items: p.items || [],
            completed: Boolean(p.completed),
          }));

          session.taskState = {
            isActive: true,
            plan: parsedPlan,
            currentStepIndex: 0,
          };
          session.mode = 'task';
          globalTaskState.updateFrom(session.taskState, result.task_name);

          taskMessages.push({
            type: 'task_update',
            plan: parsedPlan,
            current_step_index: 0,
          });

          const firstStep = parsedPlan[0]?.instruction || '';
          return {
            overrideSpeech: `Plan generated for ${result.task_name}. First step: ${firstStep}`,
            taskMessages,
          };
        } else {
          const status = getGlobalRateLimitStatus();
          if (status.isRateLimited) {
            return {
              overrideSpeech: 'Service is busy, please try again.',
              taskMessages,
            };
          }
          return {
            overrideSpeech: "I couldn't generate a valid plan.",
            taskMessages,
          };
        }
      } catch (err: any) {
        console.warn('[NETRA:Planner Error]', err?.message || err);
        return {
          overrideSpeech: 'Sorry, I failed to create a plan.',
          taskMessages,
        };
      }
    }

    default: {
      if (intent.startsWith('task_')) {
        if (!session.taskState.isActive || session.taskState.plan.length === 0) {
          return {
            overrideSpeech: 'No active task to control.',
            taskMessages,
          };
        }

        let speechOut = '';
        if (intent === 'task_skip' || intent === 'task_done') {
          session.taskState.plan[session.taskState.currentStepIndex].completed = true;
          session.taskState.currentStepIndex++;
          if (session.taskState.currentStepIndex >= session.taskState.plan.length) {
            session.taskState.isActive = false;
            session.mode = 'nav';
            globalTaskState.isActive = false;
            speechOut = 'Task completed.';
          } else {
            const nextInstr = session.taskState.plan[session.taskState.currentStepIndex].instruction;
            speechOut = `Done. Next: ${nextInstr}`;
          }
        } else if (intent === 'task_previous') {
          if (session.taskState.currentStepIndex > 0) {
            session.taskState.currentStepIndex--;
            session.taskState.plan[session.taskState.currentStepIndex].completed = false;
            speechOut = `Back to: ${session.taskState.plan[session.taskState.currentStepIndex].instruction}`;
          } else {
            speechOut = 'Already at start.';
          }
        } else if (intent === 'task_repeat') {
          speechOut = `Current step: ${session.taskState.plan[session.taskState.currentStepIndex].instruction}`;
        } else if (intent === 'task_status') {
          speechOut = `Step ${session.taskState.currentStepIndex + 1} of ${session.taskState.plan.length}.`;
        }

        globalTaskState.updateFrom(session.taskState);
        taskMessages.push({
          type: 'task_update',
          plan: session.taskState.plan,
          current_step_index: session.taskState.currentStepIndex,
        });

        return { overrideSpeech: speechOut, taskMessages };
      }

      return { overrideSpeech: null, taskMessages };
    }
  }
}
