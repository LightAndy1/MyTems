import { createLectureId, deriveLectureTitle } from '../shared/sanitize.js';
import {
  getActiveSession,
  getLecture,
  recoverStaleRecordings,
  setActiveSession,
  upsertLecture,
} from '../shared/storage.js';

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

async function handleStart({ tabId, tabTitle, streamId, courseHint }) {
  const active = await getActiveSession();
  if (active) throw new Error('Recording already in progress');
  await ensureOffscreen();

  const now = new Date();
  const lectureId = createLectureId(now);
  const title = deriveLectureTitle(tabTitle);
  const startedAtMs = now.getTime();

  await upsertLecture({
    id: lectureId,
    title,
    courseHint: (courseHint || '').trim(),
    createdAt: now.toISOString(),
    startedAtMs,
    lastChunkAtMs: startedAtMs,
    durationSec: 0,
    audioSegments: [],
    status: 'recording',
  });
  await setActiveSession({ lectureId, tabId, title, startedAtMs });

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_CAPTURE',
      lectureId,
      streamId,
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
  return { lectureId, title, startedAtMs };
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
});
