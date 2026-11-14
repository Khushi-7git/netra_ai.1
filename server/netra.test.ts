// NETRA Unit Tests with Groq & Gnani Mocks
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechManager, priorityValue } from './speech.js';
import { VisualTracker } from './tracker.js';
import {
  formatDistanceSpeech,
  parseModelJson,
  getRateLimitStatus,
  processNavFrame,
  processInquiry,
  buildSpeakMessage,
} from './processor.js';
import { PersistentMemory, memory } from './memory.js';
import { GlobalTaskState, TaskState, SessionState } from './session.js';
import { parseDir } from '../src/lib/audio.js';
import { computeMeanPixelDiff, shouldSkipFrame } from '../src/lib/frame-diff.js';
import { setAskJsonMock, setGlobalRateLimit, resetGlobalRateLimit, getGlobalRateLimitStatus } from './llm.js';
import {
  setTranscribeMock,
  setSynthesizeMock,
  detectLanguageFromText,
  resolveTtsLanguage,
} from './gnani.js';

test('priorityValue returns expected ranking', () => {
  assert.equal(priorityValue('critical'), 4);
  assert.equal(priorityValue('high'), 3);
  assert.equal(priorityValue('medium'), 2);
  assert.equal(priorityValue('low'), 1);
  assert.equal(priorityValue('info'), 0);
  assert.equal(priorityValue('unknown'), 0);
});

test('SpeechManager semanticKey removes stop words and normalizes', () => {
  const sm = new SpeechManager();
  const key1 = sm.semanticKey('large black jacket', 'ahead', 'navigation');
  assert.equal(key1, 'jacket|ahead|navigation');

  const key2 = sm.semanticKey('wooden chair', 'left', 'furniture');
  assert.equal(key2, 'chair|left|furniture');

  // If all words are stop words, original is retained
  const key3 = sm.semanticKey('tiny blue', 'ahead', 'target');
  assert.equal(key3, 'tiny blue|ahead|target');
});

test('SpeechManager shouldSpeak rules', () => {
  const sm = new SpeechManager();
  let now = 1000;

  // 1. Critical alert always speaks
  const [critOk, critReason] = sm.shouldSpeak('critical', 'obstacle', 'ahead', 'hazard', 0.4, now);
  assert.equal(critOk, true);
  assert.equal(critReason, 'critical_alert');

  // Record a low-priority speech
  sm.recordSpeech('Walking forward', 'low', 'path', 'ahead', 'navigation', 2.0, now);

  // 2. While speaking, only priority escalation + distance closing speaks
  now += 0.5;
  const [blockedOk, blockedReason] = sm.shouldSpeak('low', 'path', 'ahead', 'navigation', 2.0, now);
  assert.equal(blockedOk, false);
  assert.equal(blockedReason, 'speech_in_progress');

  // Escalation with distance closing
  const [esclOk, esclReason] = sm.shouldSpeak('high', 'chair', 'ahead', 'furniture', 1.5, now);
  assert.equal(esclOk, true);
  assert.equal(esclReason, 'priority_escalation');

  // 3. Same semantic key cooldown vs distance closed
  now += 5;
  sm.recordSpeech('Table ahead', 'medium', 'table', 'ahead', 'furniture', 2.5, now);

  now += 1.5;
  const [cooldownOk, cooldownReason] = sm.shouldSpeak('medium', 'table', 'ahead', 'furniture', 2.3, now);
  assert.equal(cooldownOk, false);
  assert.equal(cooldownReason, 'same_context_cooldown');

  const [closedOk, closedReason] = sm.shouldSpeak('medium', 'table', 'ahead', 'furniture', 1.8, now);
  assert.equal(closedOk, true);
  assert.equal(closedReason, 'distance_closed');

  // 4. Global cooldown (3.0s) for new context
  const [globalCdOk, globalCdReason] = sm.shouldSpeak('medium', 'door', 'ahead', 'target', 3.0, now);
  assert.equal(globalCdOk, false);
  assert.equal(globalCdReason, 'global_cooldown');

  now += 3.5;
  const [newContextOk, newContextReason] = sm.shouldSpeak('medium', 'door', 'ahead', 'target', 3.0, now);
  assert.equal(newContextOk, true);
  assert.equal(newContextReason, 'new_context');
});

test('VisualTracker stabilizes detections and filters confidence', () => {
  const tracker = new VisualTracker();
  let now = 100;

  const f1 = tracker.processDetections([
    { name: 'LowConf', confidence_score: 50, distance: 1.0 },
    { name: 'Cup', confidence_score: 90, distance: 2.0, direction: 'ahead' },
  ], now);

  assert.equal(f1.length, 0);

  now += 0.5;
  const f2 = tracker.processDetections([
    { name: 'Cup', confidence_score: 95, distance: 1.0, direction: 'ahead' },
  ], now);

  assert.equal(f2.length, 1);
  assert.equal(f2[0].name, 'Cup');
  assert.ok(Math.abs(f2[0].distance - 1.7) < 0.001);

  now += 2.5;
  const f3 = tracker.processDetections([], now);
  assert.equal(f3.length, 0);
  assert.equal(tracker.trackedObjects.size, 0);
});

test('formatDistanceSpeech formats centimeters and meters correctly', () => {
  assert.equal(formatDistanceSpeech(0.42), '42 centimeters');
  assert.equal(formatDistanceSpeech(0.99), '99 centimeters');
  assert.equal(formatDistanceSpeech(1.52), '1.5 meters');
  assert.equal(formatDistanceSpeech(7.22), '7.2 meters');
  assert.equal(formatDistanceSpeech(12.8), '13 meters');
});

test('parseModelJson handles raw JSON and markdown code fences', () => {
  const clean = parseModelJson('{"priority":"high","distance":1.5}');
  assert.deepEqual(clean, { priority: 'high', distance: 1.5 });

  const fenced = parseModelJson('```json\n{"action":"push","x":0,"y":0}\n```');
  assert.deepEqual(fenced, { action: 'push', x: 0, y: 0 });

  const embedded = parseModelJson('Here is your plan:\n```\n[{"step_id":1,"instruction":"Walk forward","completed":false}]\n```');
  assert.equal(Array.isArray(embedded), true);
  assert.equal(embedded[0].step_id, 1);
});

test('PersistentMemory records locations, logs objects and generates context', () => {
  const mem = new PersistentMemory();
  mem.data = { locations: {}, history: [] };

  mem.addLocation('Kitchen', 'Granite counter with coffee machine');
  assert.equal(mem.getLocationSummary(), "'Kitchen': Granite counter with coffee machine");

  mem.logObject('Coffee Mug', 'Kitchen', 'Blue ceramic mug near stove');
  mem.logObject('Coffee Mug', 'Kitchen', 'Blue ceramic mug near stove');
  assert.equal(mem.data.history.length, 1);

  const hist = mem.getHistoryContext();
  assert.ok(hist.includes("Saw Coffee Mug at 'Kitchen'"));
});

test('GlobalTaskState validity check', () => {
  const gts = new GlobalTaskState();
  const taskState: TaskState = {
    isActive: true,
    plan: [{ step_id: 1, instruction: 'Find keys', completed: false }],
    currentStepIndex: 0,
  };

  gts.updateFrom(taskState, 'Find Keys', 1000);
  assert.equal(gts.isValid(1000 + 100000), true);
  assert.equal(gts.isValid(1000 + 350000), false);
});

test('parseDir handles direction strings', () => {
  assert.equal(parseDir('slightly left'), -45);
  assert.equal(parseDir('to your right'), 45);
  assert.equal(parseDir('straight ahead'), 0);
});

test('Groq 429 rate limit cooldown sets retry delay and reports status', () => {
  resetGlobalRateLimit();
  assert.equal(getRateLimitStatus().isRateLimited, false);

  setGlobalRateLimit(25);
  const status = getRateLimitStatus();
  assert.equal(status.isRateLimited, true);
  assert.ok(status.retryAfter >= 24 && status.retryAfter <= 25);

  resetGlobalRateLimit();
  assert.equal(getRateLimitStatus().isRateLimited, false);
});

test('computeMeanPixelDiff and shouldSkipFrame behave according to threshold and 30s rule', () => {
  const thumbA = new Uint8Array(256).fill(100);
  const thumbB = new Uint8Array(256).fill(100);
  assert.equal(computeMeanPixelDiff(thumbA, thumbB), 0);

  const thumbMinor = new Uint8Array(256).fill(105);
  const diffMinor = computeMeanPixelDiff(thumbA, thumbMinor);
  assert.ok(diffMinor < 0.06);

  assert.equal(shouldSkipFrame(thumbMinor, thumbA, 1000, 5000, 0.06, 30000), true);
  assert.equal(shouldSkipFrame(thumbMinor, thumbA, 1000, 32000, 0.06, 30000), false);

  const thumbMajor = new Uint8Array(256).fill(150);
  const diffMajor = computeMeanPixelDiff(thumbA, thumbMajor);
  assert.ok(diffMajor > 0.06);
  assert.equal(shouldSkipFrame(thumbMajor, thumbA, 1000, 5000, 0.06, 30000), false);
});

// ============================================================================
// REQUIREMENT 6 ACCEPTANCE TESTS: (a), (b), (c), (d)
// ============================================================================

test('(a) a frame returns a result', async () => {
  resetGlobalRateLimit();
  setAskJsonMock(async () => {
    return {
      thinking: 'Clear hallway observed with an open doorway at 12 oclock.',
      priority: 'low',
      category: 'navigation',
      subject: 'Hallway',
      distance: 3.5,
      direction: 'ahead',
      speech: 'Hallway clear ahead.',
      scene_description: 'Bright corridor with wooden doors',
      target_detected: false,
      objects: [
        { name: 'Door', distance: 3.5, direction: 'ahead', confidence_score: 95, category: 'navigation' },
      ],
    };
  });

  const session = new SessionState('test-frame-session');
  const res = await processNavFrame(session, 'dummyImageBase64', 0);

  assert.ok(res.messages.length > 0, 'Frame must return messages');
  const resultMsg = res.messages.find((m) => m.type === 'result');
  assert.ok(resultMsg, 'Frame messages must contain a result message');
  assert.equal(resultMsg.scene, 'Bright corridor with wooden doors');
  assert.equal(resultMsg.priority, 'low');
  assert.equal(resultMsg.direction, 'ahead');

  setAskJsonMock(null);
});

test('(b) an inquiry tags a location once', async () => {
  resetGlobalRateLimit();
  // Mock Gnani STT transcription
  setTranscribeMock(async () => 'Remember this as Office Desk');

  let askJsonCalls = 0;
  setAskJsonMock(async (prompt) => {
    askJsonCalls++;
    assert.ok(prompt.includes('The user said: "Remember this as Office Desk"'), 'Prompt must contain transcribed user text');
    return {
      intent: 'tag',
      tag_name: 'Office Desk',
      scene_description: 'Corner desk with monitors and keyboard',
      speech: 'Tagged location as Office Desk.',
    };
  });

  const session = new SessionState('test-tag-session');
  const initialLocSummary = memory.getLocationSummary();

  const messages = await processInquiry(
    session,
    'dummyImageBase64',
    Buffer.from('dummy-wav').toString('base64'),
    'audio/wav'
  );

  assert.equal(askJsonCalls, 1, 'Inquiry must call askJson once');
  const speakMsg = messages.find((m) => m.type === 'speak');
  assert.ok(speakMsg, 'Inquiry should return speak message');
  assert.ok(speakMsg.text.includes('Tagged location as Office Desk'));

  // Verify memory recorded the location tag
  assert.ok(
    memory.data.locations['Office Desk'] !== undefined,
    'Memory must store the tagged location'
  );
  assert.equal(
    memory.data.locations['Office Desk'].description,
    'Corner desk with monitors and keyboard'
  );

  setTranscribeMock(null);
  setAskJsonMock(null);
});

test('(c) a task request makes exactly one planner call', async () => {
  resetGlobalRateLimit();
  setTranscribeMock(async () => 'Help me brew tea');

  let inquiryCalls = 0;
  let plannerCalls = 0;

  setAskJsonMock(async (prompt) => {
    if (prompt.includes('DECISION PROTOCOL:')) {
      inquiryCalls++;
      return {
        intent: 'task',
        task_name: 'brew tea',
        speech: 'Planning task for brewing tea.',
      };
    } else if (prompt.includes("You are NETRA's Task Planner")) {
      plannerCalls++;
      // Return wrapped plan object to also verify { plan: [...] } unwrapping
      return {
        plan: [
          { step_id: 1, instruction: 'Find the tea kettle', completed: false },
          { step_id: 2, instruction: 'Fill kettle with water', completed: false },
        ],
      };
    }
    return null;
  });

  const session = new SessionState('test-task-session');
  const messages = await processInquiry(
    session,
    'dummyImageBase64',
    Buffer.from('dummy-wav').toString('base64'),
    'audio/wav'
  );

  assert.equal(inquiryCalls, 1, 'Inquiry intent call must be made exactly once');
  assert.equal(plannerCalls, 1, 'Task request must make exactly one planner call');

  // Verify session and global task state
  assert.equal(session.taskState.isActive, true, 'Task state must be activated');
  assert.equal(session.taskState.plan.length, 2, 'Plan should contain 2 steps');
  assert.equal(session.mode, 'task', 'Session mode should switch to task');

  const taskUpdateMsg = messages.find((m) => m.type === 'task_update');
  assert.ok(taskUpdateMsg, 'Must emit task_update message');
  assert.equal(taskUpdateMsg.plan.length, 2);

  const speakMsg = messages.find((m) => m.type === 'speak');
  assert.ok(speakMsg, 'Must emit speak message with first step');
  assert.ok(speakMsg.text.includes('Find the tea kettle'));

  setTranscribeMock(null);
  setAskJsonMock(null);
});

test('(d) a TTS failure still returns the text', async () => {
  resetGlobalRateLimit();
  // Mock Gnani TTS synthesis to fail (return null or throw)
  setSynthesizeMock(async () => {
    throw new Error('Gnani TTS service timeout');
  });

  setTranscribeMock(async () => 'What is in front of me?');
  setAskJsonMock(async () => ({
    intent: 'info',
    speech: 'There is a wooden dining table straight ahead.',
  }));

  const session = new SessionState('test-tts-session');
  const messages = await processInquiry(
    session,
    'dummyImageBase64',
    Buffer.from('dummy-wav').toString('base64'),
    'audio/wav'
  );

  const speakMsg = messages.find((m) => m.type === 'speak');
  assert.ok(speakMsg, 'Must return a speak message even when TTS fails');
  assert.equal(speakMsg.text, 'There is a wooden dining table straight ahead.');
  assert.equal(speakMsg.audio, undefined, 'Audio field should be omitted when TTS fails');

  // Also test buildSpeakMessage directly
  const directMsg = await buildSpeakMessage('Test speech text', 'inquiry');
  assert.equal(directMsg.text, 'Test speech text');
  assert.equal(directMsg.audio, undefined);

  setSynthesizeMock(null);
  setTranscribeMock(null);
  setAskJsonMock(null);
});

test('(e) Gnani TTS is primary across frame, critical, and inquiry speech', async () => {
  const calls: string[] = [];
  setSynthesizeMock(async (text) => {
    calls.push(text);
    return Buffer.from('RIFF-mock-wav').toString('base64');
  });

  const frameMsg = await buildSpeakMessage('Chair ahead 2 meters.', 'frame', 'medium');
  const critMsg = await buildSpeakMessage('Stop! Obstacle directly ahead.', 'frame', 'critical');
  const inqMsg = await buildSpeakMessage('You are in a hallway.', 'inquiry');

  assert.equal(calls.length, 3);
  assert.ok(frameMsg.audio, 'Frame speech must attach Gnani audio');
  assert.ok(critMsg.audio, 'Critical speech must attach Gnani audio');
  assert.ok(inqMsg.audio, 'Inquiry speech must attach Gnani audio');

  setSynthesizeMock(null);
});

test('(f) multilingual inquiry updates session language and forwards language to Gnani TTS', async () => {
  resetGlobalRateLimit();

  assert.equal(detectLanguageFromText('मेरे सामने क्या है?'), 'hi-IN');
  assert.equal(detectLanguageFromText('என் முன்னால் என்ன உள்ளது?'), 'ta-IN');
  assert.equal(detectLanguageFromText('నా ముందు ఏముంది?'), 'te-IN');
  assert.equal(detectLanguageFromText('Hello world'), undefined);
  assert.equal(resolveTtsLanguage('हे मराठी वाक्य आहे', 'mr-IN'), 'mr-IN');
  assert.equal(resolveTtsLanguage('यह हिंदी वाक्य है', 'en-IN'), 'hi-IN');

  setTranscribeMock(async () => 'मेरे सामने क्या है?');
  const ttsLangs: Array<string | undefined> = [];
  setSynthesizeMock(async (_text, lang) => {
    ttsLangs.push(lang);
    return Buffer.from('RIFF-mock-wav').toString('base64');
  });

  setAskJsonMock(async (prompt) => {
    if (prompt.includes('DECISION PROTOCOL:')) {
      return {
        intent: 'info',
        response_language: 'hi-IN',
        speech: 'आपके सामने एक लकड़ी की मेज़ है।',
      };
    }
    assert.ok(prompt.includes('Respond in hi-IN'), 'Frame prompt must request active session language');
    return {
      priority: 'medium',
      category: 'furniture',
      subject: 'मेज़',
      distance: 1.5,
      direction: 'ahead',
      speech: 'सामने मेज़ है।',
      scene_description: 'Wooden table ahead',
      objects: [],
    };
  });

  const session = new SessionState('test-multilang-session');
  const inqMessages = await processInquiry(
    session,
    'dummyImageBase64',
    Buffer.from('dummy-wav').toString('base64'),
    'audio/wav'
  );

  assert.equal(session.language, 'hi-IN');
  const inqSpeak = inqMessages.find((m) => m.type === 'speak');
  assert.equal(inqSpeak.lang, 'hi-IN');
  assert.ok(inqSpeak.audio);

  const frameRes = await processNavFrame(session, 'dummyImageBase64', 0);
  const frameSpeak = frameRes.messages.find((m) => m.type === 'speak');
  assert.ok(frameSpeak);
  assert.equal(frameSpeak.lang, 'hi-IN');
  assert.deepEqual(ttsLangs, ['hi-IN', 'hi-IN']);

  setSynthesizeMock(null);
  setTranscribeMock(null);
  setAskJsonMock(null);
});
