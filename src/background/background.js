import { WHITEBOARD_CONFIG, WHITEBOARD_ORIGINS } from '../shared/constants.js';
import { createLectureId, deriveLectureTitle } from '../shared/sanitize.js';
import {
  getActiveSession,
  getLecture,
  getSettings,
  recoverStaleRecordings,
  setActiveSession,
  upsertLecture,
} from '../shared/storage.js';
import { createWhiteboardTracker, shouldEnableWhiteboard } from '../shared/whiteboard.js';

const WB_SESSION_KEY = 'mytems_wb_tracker';
let wbTracker = null;
let wbTabId = null;

async function getOrRestoreTracker(lectureId) {
  if (wbTracker && wbTracker.snapshot().lectureId === lectureId) return wbTracker;
  const saved = (await chrome.storage.session?.get(WB_SESSION_KEY).catch(() => null))?.[WB_SESSION_KEY];
  if (saved?.lectureId === lectureId) {
    wbTracker = createWhiteboardTracker(lectureId, saved);
    return wbTracker;
  }
  const active = await getActiveSession();
  if (active?.lectureId === lectureId) {
    wbTracker = createWhiteboardTracker(lectureId);
    return wbTracker;
  }
  return null;
}

async function maybeAttachWhiteboard({ tabId, tabTitle, lectureId, startedAtMs, whiteboardOverride }) {
  try {
    const settings = await getSettings();
    const enabled = shouldEnableWhiteboard({
      mode: settings.whiteboardMode,
      tabTitle,
      filterCsv: settings.whiteboardMeetings,
      override: whiteboardOverride ?? null,
    });
    if (!enabled || !tabId) return;

    const granted = await chrome.permissions.contains({
      permissions: ['scripting'],
      origins: WHITEBOARD_ORIGINS,
    });
    if (!granted || !chrome.scripting?.executeScript) return;

    wbTracker = createWhiteboardTracker(lectureId);
    wbTabId = tabId;
    await chrome.storage.session?.set({ [WB_SESSION_KEY]: wbTracker.snapshot() }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/whiteboard-capture.js'],
    });
    await chrome.tabs.sendMessage(tabId, {
      type: 'MYTEMS_WB_START',
      lectureId,
      startedAtMs,
      intervalMs: WHITEBOARD_CONFIG.INTERVAL_MS,
      settleIdleMs: WHITEBOARD_CONFIG.SETTLE_IDLE_MS,
      maxDirtyMs: WHITEBOARD_CONFIG.MAX_DIRTY_MS,
    });
  } catch (err) {
    console.warn('Whiteboard attach skipped:', err?.message || err);
  }
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WORKERS'],
    justification: 'Record Teams tab media and flush chunks via OPFS worker.',
  });
}

async function updateBadge(recording) {
  await chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  if (recording) await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

async function finalizeStop(result) {
  if (!result?.lectureId) return null;
  const active = await getActiveSession().catch(() => null);
  const targetTabId = wbTabId || active?.tabId;
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { type: 'MYTEMS_WB_STOP' }).catch(() => {});
  }
  wbTracker = null;
  wbTabId = null;
  await chrome.storage.session?.remove(WB_SESSION_KEY).catch(() => {});

  const existing = await getLecture(result.lectureId);
  const updated = await upsertLecture({
    ...(existing || { id: result.lectureId }),
    status: 'recorded',
    durationSec: result.durationSec,
    audioSegments: result.audioSegments,
  });
  await setActiveSession(null);
  await updateBadge(false);
  await chrome.offscreen.closeDocument().catch(() => {});
  return updated;
}

async function handleStart({ tabId, tabTitle, streamId, courseHint, whiteboardOverride, recordScreen = true }) {
  const active = await getActiveSession();
  if (active) throw new Error('Recording already in progress');
  await ensureOffscreen();

  const now = new Date();
  const lectureId = createLectureId(now);
  const title = deriveLectureTitle(tabTitle);
  const startedAtMs = now.getTime();
  const captureScreen = recordScreen !== false;

  await upsertLecture({
    id: lectureId,
    title,
    courseHint: (courseHint || '').trim(),
    createdAt: now.toISOString(),
    startedAtMs,
    lastChunkAtMs: startedAtMs,
    durationSec: 0,
    audioSegments: [],
    recordScreen: captureScreen,
    status: 'recording',
  });
  await setActiveSession({ lectureId, tabId, title, startedAtMs, recordScreen: captureScreen });

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_CAPTURE',
      lectureId,
      streamId,
      recordScreen: captureScreen,
    });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Capture failed');
    }
  } catch (err) {
    await upsertLecture({
      id: lectureId,
      status: 'error',
      error: err?.message || 'Capture failed',
    }).catch(() => {});
    await setActiveSession(null).catch(() => {});
    await updateBadge(false).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    throw err;
  }
  await updateBadge(true);
  maybeAttachWhiteboard({ tabId, tabTitle, lectureId, startedAtMs, whiteboardOverride });
  return { lectureId, title, startedAtMs, recordScreen: captureScreen };
}

async function handleStop() {
  const resp = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_CAPTURE' });
  if (!resp?.ok) throw new Error(resp?.error || 'Stop capture failed');
  return finalizeStop(resp.data);
}

chrome.runtime.onStartup.addListener(async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  const active = contexts.length ? await getActiveSession() : null;
  await recoverStaleRecordings(active?.lectureId || null);
  if (!active) {
    await setActiveSession(null);
    await updateBadge(false);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await recoverStaleRecordings(null);
  await setActiveSession(null);
  await updateBadge(false);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    handleStart(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    handleStop()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'CAPTURE_HEARTBEAT') {
    upsertLecture({
      id: msg.lectureId,
      lastChunkAtMs: msg.lastChunkAtMs,
      audioSegments: msg.audioSegments,
    }).catch(() => {});
  }
  if (msg.type === 'CAPTURE_ENDED_EXTERNALLY') {
    finalizeStop(msg).catch(() => {});
  }
  if (msg.type === 'WHITEBOARD_FRAME') {
    getOrRestoreTracker(msg.lectureId)
      .then((tracker) => {
        const filename = tracker?.accept(msg.lectureId, msg.elapsedSec, msg.base64);
        if (!filename) return null;
        chrome.storage.session?.set({ [WB_SESSION_KEY]: tracker.snapshot() }).catch(() => {});
        return chrome.runtime.sendMessage({
          type: 'OFFSCREEN_SAVE_WHITEBOARD_FRAME',
          lectureId: msg.lectureId,
          filename,
          base64: msg.base64,
        });
      })
      .then((resp) => {
        if (resp?.ok) {
          upsertLecture({ id: msg.lectureId, hasWhiteboardCaptures: true }).catch(() => {});
        }
      })
      .catch(() => {});
  }
});
