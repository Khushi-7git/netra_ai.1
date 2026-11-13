import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import { spatialAudio, audioQueue } from './lib/audio';
import {
  AppState,
  handleServerMessage,
  apiStartSession,
  apiSendFrame,
  apiSendInquiry,
  apiEndSession,
  apiCheckHealth,
} from './lib/network';
import { setupInputListeners, AudioRecorder } from './lib/input';
import { computeGrayscaleThumbnail, shouldSkipFrame } from './lib/frame-diff';

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function getCardinal(heading: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(((heading %= 360) < 0 ? heading + 360 : heading) / 45) % 8;
  return directions[index];
}

function createFallbackVideoStream(canvasRef: React.MutableRefObject<HTMLCanvasElement | null>): MediaStream | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (!ctx || !(canvas as any).captureStream) return null;

    canvasRef.current = canvas;
    canvas.dataset.running = 'true';

    let frame = 0;
    const draw = () => {
      if (canvas.dataset.running !== 'true') return;
      frame++;
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, 640, 480);

      // Subtle cybernetic grid
      ctx.strokeStyle = '#1e1e2e';
      ctx.lineWidth = 1;
      for (let x = 0; x < 640; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 480);
        ctx.stroke();
      }
      for (let y = 0; y < 480; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(640, y);
        ctx.stroke();
      }

      // Visual pulse circle
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const radius = 60 + Math.sin(frame * 0.05) * 15;
      ctx.arc(320, 220, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Horizontal scanner beam
      const beamY = (frame * 3) % 480;
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, beamY);
      ctx.lineTo(640, beamY);
      ctx.stroke();

      // Status text
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 16px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('CAMERA HARDWARE IN USE', 320, 215);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = '13px Inter, sans-serif';
      ctx.fillText('Simulated vision stream active', 320, 240);

      requestAnimationFrame(draw);
    };

    draw();
    return (canvas as any).captureStream(15);
  } catch {
    return null;
  }
}

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRecorderRef = useRef<AudioRecorder>(new AudioRecorder());
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskHudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const consecutiveFailuresRef = useRef<number>(0);
  const currentStreamRef = useRef<MediaStream | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Requirement 3 & 4: Frame comparison & voice priority tracking
  const lastSentThumbRef = useRef<Uint8Array | null>(null);
  const lastFrameSentTimeRef = useRef<number>(0);
  const frameRequestIdRef = useRef<number>(0);

  // Requirement 3: Default scan 15000ms, micro 2000ms, overridable with ?scan=ms and ?micro=ms
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const urlScanParam = searchParams?.get('scan');
  const urlMicroParam = searchParams?.get('micro');
  const initialScanMs = urlScanParam && !isNaN(Number(urlScanParam)) && Number(urlScanParam) > 0 ? Number(urlScanParam) : 15000;
  const initialMicroMs = urlMicroParam && !isNaN(Number(urlMicroParam)) && Number(urlMicroParam) > 0 ? Number(urlMicroParam) : 2000;

  // Requirement 2 & 6: Quota-driven interval & 429 doubling
  const baseScanIntervalRef = useRef<number>(initialScanMs);
  const intervalDoubledRef = useRef<boolean>(false);
  const restoreIntervalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quotaSettingsRef = useRef<{ quotaRpm: number; scanIntervalMs: number }>({
    quotaRpm: 20,
    scanIntervalMs: initialScanMs,
  });

  // Intel panel quota line state
  const [quotaInfo, setQuotaInfo] = useState<{ quotaRpm: number; scanIntervalMs: number }>({
    quotaRpm: 20,
    scanIntervalMs: initialScanMs,
  });

  // Health and secrets card state
  const [healthInfo, setHealthInfo] = useState<{
    checked: boolean;
    hasKey: boolean;
    hasGroqKey?: boolean;
    hasGnaniKey?: boolean;
  }>({
    checked: false,
    hasKey: true,
  });
  const [dismissSecretCard, setDismissSecretCard] = useState<boolean>(false);

  const stateRef = useRef<AppState>({
    scanInterval: initialScanMs,
    microInterval: initialMicroMs,
    active: false,
    debug: false,
    mode: 'nav',
    heading: 0,
    lastShake: 0,
    lastGeiger: 0,
    sessionId:
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `netra-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  });

  // UI Helper Functions (Section 10.4)
  const showFeedback = (text: string) => {
    const el = document.getElementById('mainFeedback');
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');

    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = setTimeout(() => {
      el.classList.remove('visible');
      feedbackTimerRef.current = null;
    }, 1500);
  };

  const updateStatus = (text: string, cls: string) => {
    const textEl = document.getElementById('statusText');
    const dotEl = document.getElementById('statusDot');
    const pillEl = document.getElementById('statusPill');

    if (textEl) textEl.textContent = text;
    if (dotEl) dotEl.className = 'status-dot ' + (cls || '');

    // Section 10.4 Fix: status pill becomes visible when started, hidden when stopped
    if (pillEl) {
      if (stateRef.current.active) {
        pillEl.classList.add('visible');
      } else {
        pillEl.classList.remove('visible');
      }
    }
  };

  const toggleIntelLayer = () => {
    const state = stateRef.current;
    state.debug = !state.debug;
    const layer = document.getElementById('intelligence-layer');
    if (layer) {
      layer.classList.toggle('visible', state.debug);
      layer.setAttribute('aria-hidden', String(!state.debug));
    }

    if (state.debug) {
      spatialAudio.playTone(800, 'sine', 0.1);
      showFeedback('INTEL ON');
    } else {
      spatialAudio.playTone(400, 'sine', 0.1);
      showFeedback('INTEL OFF');
    }
  };

  const toggleDebugConsole = () => {
    const consoleEl = document.getElementById('console-log');
    if (!consoleEl) return;
    const isVisible = consoleEl.classList.toggle('visible');
    consoleEl.setAttribute('aria-hidden', String(!isVisible));
  };

  const announce = (text: string) => {
    const announcer = document.getElementById('a11y-announcer');
    if (announcer) {
      announcer.textContent = text;
    }
  };

  const updateNavUI = (msg: any) => {
    // Search banner
    const searchBanner = document.getElementById('searchBanner');
    if (searchBanner) {
      if (msg.current_goal) {
        searchBanner.textContent = `SEARCH: ${msg.current_goal}`;
        searchBanner.classList.add('visible');
      } else {
        searchBanner.classList.remove('visible');
      }
    }

    // Thinking box
    const thinkingBox = document.getElementById('thinkingBox');
    if (thinkingBox) {
      thinkingBox.textContent = msg.thinking || msg.scene || 'Processing visual environment...';
    }

    // Social cue box
    const socialCue = document.getElementById('socialCue');
    if (socialCue) {
      const intent = msg.social_cues?.intent;
      if (intent && intent !== 'none') {
        const details = msg.social_cues.details || intent;
        socialCue.innerHTML = `👥 <b>Social:</b> ${escapeHtml(details)}`;
        socialCue.style.display = 'block';
      } else {
        socialCue.innerHTML = '';
        socialCue.style.display = 'none';
      }
    }

    // Environmental cue box
    const envCue = document.getElementById('envCue');
    if (envCue) {
      const occupancy = msg.environment?.occupancy;
      if (occupancy === 'occupied') {
        const marker = msg.environment.markers?.[0] || 'Obstruction';
        envCue.innerHTML = `🚧 <b>Env:</b> ${escapeHtml(marker)}`;
        envCue.style.display = 'block';
      } else {
        envCue.innerHTML = '';
        envCue.style.display = 'none';
      }
    }

    // Telemetry
    const distVal = document.getElementById('distVal');
    if (distVal) {
      const d = Number(msg.distance ?? 0);
      if (d < 1.0) {
        distVal.innerHTML = `${Math.round(d * 100)}<small>cm</small>`;
      } else {
        distVal.innerHTML = `${d.toFixed(1)}<small>m</small>`;
      }
    }

    const dirVal = document.getElementById('dirVal');
    if (dirVal) {
      dirVal.textContent = msg.direction || '--';
    }

    const latVal = document.getElementById('latVal');
    if (latVal && msg.ms !== undefined) {
      latVal.innerHTML = `${Math.round(msg.ms)}<small>ms</small>`;
    }

    // Objects list
    const objList = document.getElementById('objList');
    const objCount = document.getElementById('objCount');
    if (objList && objCount) {
      const objects = Array.isArray(msg.objects) ? msg.objects : [];
      objCount.textContent = String(objects.length);

      if (objects.length === 0) {
        objList.innerHTML = `<div style="text-align: center; color: var(--text-mute); padding: 12px; font-size: 13px;">Scanning...</div>`;
      } else {
        objList.innerHTML = objects
          .map((obj: any) => {
            const d = Number(obj.distance ?? 0);
            const nearCls = d < 1.0 ? ' near' : '';
            return `<div class="obj-item">
              <span>${escapeHtml(obj.name || 'Object')}</span>
              <span class="obj-dist${nearCls}">${d.toFixed(1)}m</span>
            </div>`;
          })
          .join('');
      }
    }
  };

  const updateMicroUI = (msg: any) => {
    const latVal = document.getElementById('latVal');
    if (latVal && msg.ms !== undefined) {
      latVal.innerHTML = `${Math.round(msg.ms)}<small>ms</small>`;
    }
  };

  const updateTaskUI = (msg: any) => {
    const taskHud = document.getElementById('task-hud');
    const taskFeedback = document.getElementById('taskFeedback');
    const taskList = document.getElementById('taskList');
    const latVal = document.getElementById('latVal');

    if (taskHud) {
      taskHud.classList.add('visible');
    }

    if (taskFeedback) {
      taskFeedback.textContent = msg.visual_feedback || '';
    }

    if (latVal && msg.ms !== undefined) {
      latVal.innerHTML = `${Math.round(msg.ms)}<small>ms</small>`;
    }

    const plan = Array.isArray(msg.plan) ? msg.plan : [];
    const curIdx = Number(msg.current_step_index ?? 0);

    if (taskList) {
      taskList.innerHTML = plan
        .map((step: any, idx: number) => {
          const isCompleted = idx < curIdx || step.completed;
          const isActive = idx === curIdx && !isCompleted;
          const cls = isCompleted ? ' completed' : isActive ? ' active' : '';
          return `<div class="task-step${cls}">
            <span class="step-num">${idx + 1}</span>
            <span>${escapeHtml(step.instruction || '')}</span>
          </div>`;
        })
        .join('');
    }

    if (curIdx >= plan.length && plan.length > 0) {
      if (taskHudTimerRef.current) {
        clearTimeout(taskHudTimerRef.current);
      }
      taskHudTimerRef.current = setTimeout(() => {
        taskHud?.classList.remove('visible');
        taskHudTimerRef.current = null;
      }, 5000);
    }
  };

  const updateInquiryUI = (msg: any) => {
    const thinkingBox = document.getElementById('thinkingBox');
    if (thinkingBox && msg.thinking) {
      thinkingBox.textContent = msg.thinking;
    }

    const searchBanner = document.getElementById('searchBanner');
    if (searchBanner) {
      if (msg.current_goal) {
        searchBanner.textContent = `SEARCH: ${msg.current_goal}`;
        searchBanner.classList.add('visible');
      } else {
        searchBanner.classList.remove('visible');
      }
    }

    const latVal = document.getElementById('latVal');
    if (latVal && msg.ms !== undefined) {
      latVal.innerHTML = `${Math.round(msg.ms)}<small>ms</small>`;
    }
  };

  const restartLoop = (intervalMs: number) => {
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    if (stateRef.current.active) {
      scheduleNextTick(intervalMs);
    }
  };

  const scheduleNextTick = (delay: number) => {
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
    }
    loopTimerRef.current = setTimeout(runLoopTick, delay);
  };

  // Frame Capture & Processing Loop (Section 10.5)
  const captureFrame = (maxWidth: number, maxHeight: number): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(maxWidth / vw, maxHeight / vh, 1.0);
    const targetW = Math.round(vw * scale);
    const targetH = Math.round(vh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, targetW, targetH);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    return dataUrl.split(',')[1] || null;
  };

  const runLoopTick = async () => {
    const state = stateRef.current;
    if (!state.active) return;

    // Skip if request is already in flight (Section 10.5)
    if (inFlightRef.current) {
      scheduleNextTick(state.mode === 'micro' ? state.microInterval : state.scanInterval);
      return;
    }

    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      scheduleNextTick(state.mode === 'micro' ? state.microInterval : state.scanInterval);
      return;
    }

    // Requirement 3: Skip near-identical frames before sending
    const currentThumb = computeGrayscaleThumbnail(video, 16, 16);
    if (
      shouldSkipFrame(
        currentThumb,
        lastSentThumbRef.current,
        lastFrameSentTimeRef.current,
        Date.now(),
        0.06,
        30000
      )
    ) {
      scheduleNextTick(state.mode === 'micro' ? state.microInterval : state.scanInterval);
      return;
    }

    const isMicro = state.mode === 'micro';
    const maxBox = isMicro ? 224 : 224;
    const maxH = isMicro ? 224 : 160;
    const imageBase64 = captureFrame(maxBox, maxH);

    if (!imageBase64) {
      scheduleNextTick(isMicro ? state.microInterval : state.scanInterval);
      return;
    }

    // Requirement 4: Track frame request ID to invalidate response if voice inquiry starts
    const thisRequestId = ++frameRequestIdRef.current;
    inFlightRef.current = true;

    try {
      const response = await apiSendFrame(
        state.sessionId,
        imageBase64,
        state.heading
      );

      // If user started voice inquiry while frame was in flight, ignore response
      if (thisRequestId !== frameRequestIdRef.current) {
        return;
      }

      // Record sent frame thumbnail and timestamp
      lastSentThumbRef.current = currentThumb;
      lastFrameSentTimeRef.current = Date.now();

      const isReal429 = Boolean(response?.is429);
      const isRateLimited = Boolean(response?.rate_limited || response?.rateLimited);
      const retrySec = response?.retryAfter || 0;

      // Requirement 6: Double scan interval once on real 429 (capped at 60s), restore after 2 min
      if (isReal429) {
        if (!intervalDoubledRef.current) {
          intervalDoubledRef.current = true;
          state.scanInterval = Math.min(60000, state.scanInterval * 2);
          setQuotaInfo({
            quotaRpm: quotaSettingsRef.current.quotaRpm,
            scanIntervalMs: state.scanInterval,
          });
        }
        if (restoreIntervalTimerRef.current) {
          clearTimeout(restoreIntervalTimerRef.current);
        }
        restoreIntervalTimerRef.current = setTimeout(() => {
          state.scanInterval = baseScanIntervalRef.current;
          intervalDoubledRef.current = false;
          restoreIntervalTimerRef.current = null;
          setQuotaInfo({
            quotaRpm: quotaSettingsRef.current.quotaRpm,
            scanIntervalMs: baseScanIntervalRef.current,
          });
        }, 120000);
      }

      // Requirement 6: Do not stop loop for whole window. Show HUD countdown only if retryAfter > 10.
      if (isRateLimited) {
        if (retrySec > 10) {
          showFeedback('QUOTA LIMIT');
          let remaining = retrySec;
          updateStatus(`Cooldown ${remaining}s`, 'error');

          const countdown = setInterval(() => {
            remaining--;
            if (remaining > 0 && stateRef.current.active) {
              updateStatus(`Cooldown ${remaining}s`, 'error');
            } else {
              clearInterval(countdown);
              if (stateRef.current.active) {
                updateStatus('Scanning', 'active');
              }
            }
          }, 1000);
        } else {
          updateStatus(`Busy (${retrySec || 5}s)`, 'error');
        }

        if (response && Array.isArray(response.messages)) {
          for (const msg of response.messages) {
            handleServerMessage(msg, state, {
              showFeedback,
              updateStatus,
              restartLoop,
              updateNavUI,
              updateMicroUI,
              updateTaskUI,
              updateInquiryUI,
              announce,
            });
          }
        }

        // Wait at least the cooldown period before attempting the next frame tick
        const delay = Math.max(state.mode === 'micro' ? state.microInterval : state.scanInterval, (retrySec || 5) * 1000);
        scheduleNextTick(delay);
        return;
      }

      consecutiveFailuresRef.current = 0;
      if (response && Array.isArray(response.messages)) {
        for (const msg of response.messages) {
          handleServerMessage(msg, state, {
            showFeedback,
            updateStatus,
            restartLoop,
            updateNavUI,
            updateMicroUI,
            updateTaskUI,
            updateInquiryUI,
            announce,
          });
        }
      }
    } catch (err) {
      console.error('[NETRA:Frame Client Error]', err);
      consecutiveFailuresRef.current++;

      // Section 10.5: After 3 consecutive failures, back off with min(5000, 1000 * 1.5^retries)
      if (consecutiveFailuresRef.current >= 3) {
        updateStatus('Reconnecting...', 'error');
        const backoff = Math.min(
          5000,
          1000 * Math.pow(1.5, consecutiveFailuresRef.current)
        );
        inFlightRef.current = false;
        scheduleNextTick(backoff);
        return;
      }
    } finally {
      inFlightRef.current = false;
    }

    scheduleNextTick(state.mode === 'micro' ? state.microInterval : state.scanInterval);
  };

  // Start / Stop System (Section 10.5)
  const startSystem = async () => {
    try {
      // 1. Audio context init must happen inside user gesture
      spatialAudio.init();

      // iOS Motion Permission check
      if (typeof (DeviceMotionEvent as any)?.requestPermission === 'function') {
        try {
          await (DeviceMotionEvent as any).requestPermission();
        } catch {}
      }

      // Clean up any previously opened tracks first to avoid hardware locking
      if (currentStreamRef.current) {
        currentStreamRef.current.getTracks().forEach((track) => track.stop());
        currentStreamRef.current = null;
      }
      if (videoRef.current && videoRef.current.srcObject) {
        const prev = videoRef.current.srcObject as MediaStream;
        if (prev?.getTracks) {
          prev.getTracks().forEach((track) => track.stop());
        }
        videoRef.current.srcObject = null;
      }
      if (fallbackCanvasRef.current) {
        fallbackCanvasRef.current.dataset.running = 'false';
        fallbackCanvasRef.current = null;
      }

      // Request camera with fallback handling for 'Device in use'
      let stream: MediaStream | null = null;
      let usedFallbackStream = false;

      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
            },
          });
        } catch (firstErr: any) {
          const errMsg = String(firstErr?.message || firstErr?.name || '');
          const isDeviceInUse =
            errMsg.includes('in use') ||
            errMsg.includes('NotReadableError') ||
            errMsg.includes('TrackStartError');

          if (isDeviceInUse) {
            console.warn('[NETRA:Start] Camera device in use. Retrying with basic constraints...');
            await new Promise((r) => setTimeout(r, 400));
            try {
              stream = await navigator.mediaDevices.getUserMedia({ video: true });
            } catch {
              console.warn('[NETRA:Start] Camera device remains locked. Using simulated visual stream.');
              stream = createFallbackVideoStream(fallbackCanvasRef);
              usedFallbackStream = true;
            }
          } else {
            console.warn('[NETRA:Start] Camera not accessible. Using simulated visual stream.');
            stream = createFallbackVideoStream(fallbackCanvasRef);
            usedFallbackStream = true;
          }
        }
      } else {
        stream = createFallbackVideoStream(fallbackCanvasRef);
        usedFallbackStream = true;
      }

      currentStreamRef.current = stream;
      const video = videoRef.current;
      if (video && stream) {
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
          if (video.readyState >= 1) {
            video.play().catch(() => {});
            resolve();
          } else {
            video.onloadedmetadata = () => {
              video.play().catch(() => {});
              resolve();
            };
            // Fallback timeout in case onloadedmetadata doesn't fire
            setTimeout(() => {
              video.play().catch(() => {});
              resolve();
            }, 1000);
          }
        });
      }

      stateRef.current.active = true;
      document.body.classList.add('active');
      if (usedFallbackStream) {
        showFeedback('SIMULATED CAM');
        updateStatus('Cam In Use', 'warning');
      } else {
        showFeedback('NETRA ACTIVE');
        updateStatus('Connecting...', 'active');
      }

      // Start session and configure scanIntervalMs and microInterval
      const sessionStartData = await apiStartSession(stateRef.current.sessionId);
      const scanMs = urlScanParam ? baseScanIntervalRef.current : (sessionStartData.scanIntervalMs || 15000);
      const rpm = sessionStartData.quotaRpm ?? 20;
      const microMs = urlMicroParam ? stateRef.current.microInterval : (sessionStartData.microIntervalMs || 2000);
      stateRef.current.scanInterval = scanMs;
      baseScanIntervalRef.current = scanMs;
      stateRef.current.microInterval = microMs;
      quotaSettingsRef.current = { quotaRpm: rpm, scanIntervalMs: scanMs };
      setQuotaInfo({ quotaRpm: rpm, scanIntervalMs: scanMs });

      for (const msg of sessionStartData.messages) {
        handleServerMessage(msg, stateRef.current, {
          showFeedback,
          updateStatus,
          restartLoop,
          updateNavUI,
          updateMicroUI,
          updateTaskUI,
          updateInquiryUI,
          announce,
        });
      }

      updateStatus(usedFallbackStream ? 'Simulated Vision' : 'Scanning', 'active');
      // Requirement 3: Send the first frame immediately on start
      scheduleNextTick(0);
    } catch (err: any) {
      console.warn('[NETRA:Start] Initialization notice:', err?.message || err);
      showFeedback('CAMERA BUSY');
      updateStatus('Cam Busy', 'error');
    }
  };

  const stopSystem = async () => {
    stateRef.current.active = false;
    stateRef.current.mode = 'nav';
    spatialAudio.stopMicroTone();
    document.body.classList.remove('active');

    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }

    if (restoreIntervalTimerRef.current) {
      clearTimeout(restoreIntervalTimerRef.current);
      restoreIntervalTimerRef.current = null;
    }
    intervalDoubledRef.current = false;

    if (currentStreamRef.current) {
      currentStreamRef.current.getTracks().forEach((track) => track.stop());
      currentStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (fallbackCanvasRef.current) {
      fallbackCanvasRef.current.dataset.running = 'false';
      fallbackCanvasRef.current = null;
    }

    await apiEndSession(stateRef.current.sessionId);
    showFeedback('STOPPED');
    updateStatus('Ready', '');
  };

  const toggleSystem = () => {
    if (stateRef.current.active) {
      stopSystem();
    } else {
      startSystem();
    }
  };

  // Voice Recording (Section 10.7)
  const handleStartRecording = async () => {
    if (!stateRef.current.active) {
      showFeedback('START FIRST');
      return;
    }

    // Requirement 4: Priority - voice inquiry invalidates in-flight frame scan immediately
    frameRequestIdRef.current++;

    showFeedback('LISTENING...');
    // Requirement 5: Cancel playing audio and speechSynthesis when recording starts
    audioQueue.cancel();
    spatialAudio.playTone(880, 'sine', 0.1);

    // Requirement 4: Auto-stop recording at 29s
    const started = await audioRecorderRef.current.start(() => {
      handleStopRecording();
    });
    if (!started) {
      showFeedback('MIC BLOCKED');
    }
  };

  const handleStopRecording = async () => {
    if (!audioRecorderRef.current.isRecording()) return;

    // Requirement 4: Priority - invalidate any frame in flight
    frameRequestIdRef.current++;

    showFeedback('THINKING...');
    spatialAudio.playTone(440, 'sine', 0.1);

    try {
      const recordResult = await audioRecorderRef.current.stop();
      if (!recordResult) {
        return; // Ignored if shorter than 300 ms
      }

      // Capture a 4:3 frame (max 224 x 168) - Hold-to-ask voice inquiries are never skipped (Requirement 3)
      const imageBase64 = captureFrame(224, 168) || '';
      const messages = await apiSendInquiry(
        stateRef.current.sessionId,
        imageBase64,
        recordResult.base64,
        recordResult.mimeType
      );

      for (const msg of messages) {
        handleServerMessage(msg, stateRef.current, {
          showFeedback,
          updateStatus,
          restartLoop,
          updateNavUI,
          updateMicroUI,
          updateTaskUI,
          updateInquiryUI,
          announce,
        });
      }
    } catch (err) {
      console.error('[NETRA:Inquiry Client Error]', err);
      showFeedback('TRY AGAIN');
    }
  };

  const handleHeadingChange = (heading: number) => {
    stateRef.current.heading = heading;
    const compassVal = document.getElementById('compassVal');
    if (compassVal) {
      compassVal.textContent = `${heading}° ${getCardinal(heading)}`;
    }
  };

  // Lifecycle & Input Setup
  useEffect(() => {
    // Check backend health
    apiCheckHealth()
      .then((health) => {
        setHealthInfo({
          checked: true,
          hasKey: Boolean(health.hasKey),
          hasGroqKey: Boolean(health.hasGroqKey),
          hasGnaniKey: Boolean(health.hasGnaniKey),
        });
        if (!health.hasKey) {
          console.warn('[NETRA] Server reports GROQ_KEY is not set.');
        }
      })
      .catch(() => {
        setHealthInfo({ checked: true, hasKey: false });
      });

    // Setup mirror for console log
    const consoleEl = document.getElementById('console-log');
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;

    const appendLog = (type: 'info' | 'warn' | 'error', args: any[]) => {
      if (!consoleEl) return;
      const row = document.createElement('div');
      row.className = `log-entry log-${type}`;
      row.textContent = `[${new Date().toLocaleTimeString()}] ` + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      consoleEl.appendChild(row);
      if (consoleEl.childNodes.length > 100) {
        consoleEl.removeChild(consoleEl.firstChild!);
      }
      consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    console.log = (...args) => {
      origLog(...args);
      appendLog('info', args);
    };
    console.warn = (...args) => {
      origWarn(...args);
      appendLog('warn', args);
    };
    console.error = (...args) => {
      origErr(...args);
      appendLog('error', args);
    };

    const cleanupInputs = setupInputListeners(null, {
      onToggleSystem: toggleSystem,
      onToggleIntel: toggleIntelLayer,
      onToggleConsole: toggleDebugConsole,
      onStartRecording: handleStartRecording,
      onStopRecording: handleStopRecording,
      onHeadingChange: handleHeadingChange,
    });

    return () => {
      cleanupInputs();
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
      if (loopTimerRef.current) clearTimeout(loopTimerRef.current);
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (taskHudTimerRef.current) clearTimeout(taskHudTimerRef.current);
    };
  }, []);

  return (
    <>
      <div id="a11y-announcer" className="sr-only" aria-live="assertive"></div>
      <div id="console-log" role="log" aria-label="Debug Console" aria-hidden="true"></div>

      {/* LAYER 1: REALITY */}
      <video
        ref={videoRef}
        id="cam"
        autoPlay
        playsInline
        muted
        aria-label="Camera Feed"
        role="img"
      ></video>

      {/* LAYER 2: VITAL HUD */}
      <main className="hud-layer">
        <header className="hud-header" role="banner">
          <div id="statusPill" className="status-pill" role="status" aria-live="polite">
            <div id="statusDot" className="status-dot"></div>
            <span id="statusText" className="status-text">Ready</span>
          </div>
          <div id="searchBanner" className="search-banner" role="status" aria-live="assertive">
            Searching...
          </div>
        </header>

        <section className="hud-center" aria-label="Primary Feedback">
          <div className="heartbeat" aria-hidden="true"></div>
          <div id="mainFeedback" className="main-feedback" role="alert"></div>
        </section>

        <footer className="hud-footer" role="contentinfo">
          <div id="gestureHint" className="gesture-hint">
            Double-tap to Start • Hold to Ask • Shake for Intel
          </div>
        </footer>
      </main>

      {/* LAYER 3: TASK HUD */}
      <aside id="task-hud" role="complementary" aria-label="Current Task Steps">
        <div className="task-header">Interactive Guidance</div>
        <div id="taskList" role="list"></div>
        <div
          id="taskFeedback"
          className="task-feedback"
          role="status"
          aria-live="polite"
        ></div>
      </aside>

      {/* LAYER 4: INTELLIGENCE GRID */}
      <section
        id="intelligence-layer"
        role="region"
        aria-label="AI Intelligence details"
        aria-hidden="true"
      >
        <article className="glass-card area-reasoning">
          <header className="card-header">
            <h2>🧠 AI Reasoning</h2>
            <span id="compassVal" className="accent-text">0° N</span>
          </header>
          <div id="thinkingBox" className="reasoning-text" role="log">Initializing...</div>
          <div id="socialCue" className="context-cue cue-info" role="status"></div>
          <div id="envCue" className="context-cue cue-warning" role="status"></div>
          <div
            id="quotaInfo"
            style={{
              fontSize: '11px',
              color: 'var(--text-mute, #94a3b8)',
              marginTop: '8px',
              fontFamily: 'monospace',
              letterSpacing: '0.02em',
            }}
          >
            Quota: {quotaInfo.quotaRpm} RPM, scan every {Math.round(quotaInfo.scanIntervalMs / 1000)}s
          </div>
        </article>

        <article className="glass-card area-objects">
          <header className="card-header">
            <h2>Detected Objects</h2>
            <span id="objCount" className="badge">0</span>
          </header>
          <div id="objList" className="obj-list" role="list"></div>
        </article>

        <div className="area-telemetry">
          <div className="stat-box">
            <div id="distVal" className="stat-val">--</div>
            <div className="stat-label">Distance</div>
          </div>
          <div className="stat-box">
            <div id="dirVal" className="stat-val">--</div>
            <div className="stat-label">Direction</div>
          </div>
          <div className="stat-box">
            <div id="latVal" className="stat-val">--</div>
            <div className="stat-label">Latency</div>
          </div>
        </div>
      </section>

      {/* Additive desktop start button for first-time / non-touch users (Section 10.6 & 12.8) */}
      <button
        id="startBtn"
        type="button"
        className="desktop-start-btn"
        aria-label="Start NETRA"
        onClick={startSystem}
      >
        Start NETRA
      </button>

      {/* Requirement 1: Card asking for GROQ_KEY & GNANI_KEY when missing */}
      {!healthInfo.hasKey && !dismissSecretCard && (
        <div
          role="dialog"
          aria-labelledby="secrets-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div
            style={{
              maxWidth: '520px',
              width: '100%',
              backgroundColor: '#0c0d12',
              border: '1px solid rgba(245, 158, 11, 0.5)',
              borderRadius: '16px',
              padding: '24px',
              color: '#ffffff',
              boxShadow: '0 20px 40px rgba(0,0,0,0.8), 0 0 20px rgba(245,158,11,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div id="secrets-dialog-title" style={{ fontSize: '17px', fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>⚠️</span> Configuration Required
              </div>
              <button
                type="button"
                onClick={() => setDismissSecretCard(true)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>

            <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.5', marginBottom: '16px' }}>
              NETRA requires <strong>Groq</strong> (for vision &amp; reasoning) and <strong>Gnani Vachana</strong> (for voice recognition &amp; audio). Please configure them in your server <strong>Environment Variables</strong> (or <strong>Settings &gt; Secrets</strong>):
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px', fontFamily: 'monospace', fontSize: '11px' }}>
              <div style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '8px', padding: '10px' }}>
                <div style={{ color: '#818cf8', fontWeight: 600, marginBottom: '4px' }}>GROQ_KEY (Required):</div>
                <div style={{ color: '#f8fafc', lineHeight: '1.45' }}>
                  Configure your Groq API key in the server environment
                </div>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '10px' }}>
                <div style={{ color: '#34d399', fontWeight: 600, marginBottom: '4px' }}>GNANI_KEY (Speech &amp; Voice):</div>
                <div style={{ color: '#f8fafc', lineHeight: '1.45' }}>
                  Configure your Gnani Vachana API key in the server environment
                </div>
              </div>
            </div>

            <details style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '20px', cursor: 'pointer' }}>
              <summary style={{ fontWeight: 600, color: '#cbd5e1' }}>Optional Settings (Defaults)</summary>
              <div style={{ marginTop: '8px', background: 'rgba(0,0,0,0.4)', padding: '10px', borderRadius: '6px', fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.6' }}>
                <div>GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct</div>
                <div>GNANI_STT_LANGUAGE=indic-auto</div>
                <div>GNANI_TTS_VOICE=Nalini</div>
                <div>GNANI_TTS_LANGUAGE=en-IN</div>
                <div>GNANI_TTS_MODE=inquiry</div>
              </div>
            </details>

            <button
              type="button"
              onClick={async () => {
                try {
                  const h = await apiCheckHealth();
                  setHealthInfo({
                    checked: true,
                    hasKey: Boolean(h.hasKey),
                    hasGroqKey: Boolean(h.hasGroqKey),
                    hasGnaniKey: Boolean(h.hasGnaniKey),
                  });
                  if (h.hasKey) {
                    showFeedback('KEYS DETECTED');
                  } else {
                    showFeedback('STILL MISSING');
                  }
                } catch {
                  showFeedback('CHECK FAILED');
                }
              }}
              style={{
                width: '100%',
                padding: '10px 16px',
                borderRadius: '8px',
                background: '#4f46e5',
                color: '#ffffff',
                border: 'none',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
            >
              Re-check Server Configuration
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
