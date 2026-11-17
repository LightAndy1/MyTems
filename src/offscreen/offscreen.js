import { RECORDING_CONFIG } from '../shared/constants.js';
import { computeOffsetSec, formatSegmentFilename, pickVideoMimeType } from './segment-math.js';

const worker = new Worker(new URL('./opfs-writer.worker.js', import.meta.url));
let reqSeq = 0;
const pending = new Map();

worker.onmessage = (e) => {
  const resolver = pending.get(e.data.id);
  if (!resolver) return;
  pending.delete(e.data.id);
  if (e.data.ok) resolver.resolve();
  else resolver.reject(new Error(e.data.error));
};

worker.onerror = (e) => {
  const err = new Error(e?.message || 'OPFS worker error');
  for (const [id, resolver] of pending.entries()) {
    pending.delete(id);
    resolver.reject(err);
  }
};

function callWorker(payload, transfer = []) {
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload }, transfer);
  });
}

let session = null;

function startAudioSegment(targetSession, lectureId, audioStream, startedAtMs, index) {
  const relPath = formatSegmentFilename(index);
  const offsetSec = computeOffsetSec(startedAtMs, Date.now());
  const recorder = new MediaRecorder(audioStream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: RECORDING_CONFIG.AUDIO_BPS,
  });
  let writeChain = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    writeChain = writeChain.then(async () => {
      const buf = await e.data.arrayBuffer();
      await callWorker({ type: 'append', lectureId, relPath, bytes: buf }, [buf]);
    });
  };
  let segment;
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = async () => {
      try {
        await writeChain;
        await callWorker({ type: 'close', lectureId, relPath });
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        targetSession.activeAudios.delete(segment);
      }
    };
  });
  segment = { recorder, stopped };
  targetSession.activeAudios.add(segment);
  recorder.start(RECORDING_CONFIG.TIMESLICE_MS);
  targetSession.audioSegments.push({ filename: relPath, offsetSec });
  return segment;
}

async function startCapture({ lectureId, streamId }) {
  if (session) throw new Error('Capture already active');
  let stream = null;
  let audioCtx = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          googDisableLocalEcho: false,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: RECORDING_CONFIG.MAX_WIDTH,
          maxHeight: RECORDING_CONFIG.MAX_HEIGHT,
          maxFrameRate: RECORDING_CONFIG.MAX_FPS,
        },
      },
    });

    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);

    const startedAtMs = Date.now();
    const audioStream = new MediaStream(stream.getAudioTracks());

    const videoRecorder = new MediaRecorder(stream, {
      mimeType: pickVideoMimeType((m) => MediaRecorder.isTypeSupported(m)),
      videoBitsPerSecond: RECORDING_CONFIG.VIDEO_BPS,
      audioBitsPerSecond: RECORDING_CONFIG.AUDIO_BPS,
    });

    let videoChain = Promise.resolve();
    videoRecorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      videoChain = videoChain.then(async () => {
        const buf = await e.data.arrayBuffer();
        await callWorker({ type: 'append', lectureId, relPath: 'video.webm', bytes: buf }, [buf]);
        chrome.runtime.sendMessage({
          type: 'CAPTURE_HEARTBEAT',
          lectureId,
          lastChunkAtMs: Date.now(),
          audioSegments: session?.audioSegments || [],
        }).catch(() => {});
      });
    };

    const videoStopped = new Promise((resolve, reject) => {
      videoRecorder.onstop = async () => {
        try {
          await videoChain;
          await callWorker({ type: 'close', lectureId, relPath: 'video.webm' });
          resolve();
        } catch (err) {
          reject(err);
        }
      };
    });

    const newSession = {
      lectureId,
      startedAtMs,
      stream,
      audioStream,
      audioCtx,
      videoRecorder,
      videoStopped,
      audioSegments: [],
      segmentIndex: 0,
      currentAudio: null,
      activeAudios: new Set(),
      overlapTimers: new Set(),
      rolloverTimer: null,
    };
    session = newSession;

    newSession.currentAudio = startAudioSegment(newSession, lectureId, audioStream, startedAtMs, 0);
    videoRecorder.start(RECORDING_CONFIG.TIMESLICE_MS);

    newSession.rolloverTimer = setInterval(() => {
      if (session !== newSession) return;
      const prev = newSession.currentAudio;
      newSession.segmentIndex += 1;
      newSession.currentAudio = startAudioSegment(
        newSession,
        lectureId,
        audioStream,
        startedAtMs,
        newSession.segmentIndex
      );
      const timer = setTimeout(() => {
        newSession.overlapTimers.delete(timer);
        if (prev?.recorder.state === 'recording') prev.recorder.stop();
      }, RECORDING_CONFIG.AUDIO_OVERLAP_MS);
      newSession.overlapTimers.add(timer);
    }, RECORDING_CONFIG.AUDIO_SEGMENT_MS);

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopCapture()
        .then((res) => {
          if (res) {
            chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED_EXTERNALLY', ...res }).catch(() => {});
          }
        })
        .catch(() => {});
    });
  } catch (err) {
    if (session) {
      const failed = session;
      session = null;
      clearInterval(failed.rolloverTimer);
      for (const timer of failed.overlapTimers) clearTimeout(timer);
      failed.overlapTimers.clear();
      if (failed.videoRecorder.state === 'recording') failed.videoRecorder.stop();
      for (const seg of failed.activeAudios) {
        if (seg.recorder.state === 'recording') seg.recorder.stop();
      }
    }
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
    }
    await audioCtx?.close().catch(() => {});
    throw err;
  }
}

async function stopCapture() {
  if (!session) return null;
  const active = session;
  session = null;
  clearInterval(active.rolloverTimer);
  for (const timer of active.overlapTimers) clearTimeout(timer);
  active.overlapTimers.clear();

  const audioSegmentsToStop = [...active.activeAudios];
  if (active.videoRecorder.state === 'recording') active.videoRecorder.stop();
  for (const seg of audioSegmentsToStop) {
    if (seg.recorder.state === 'recording') seg.recorder.stop();
  }

  try {
    await Promise.all([active.videoStopped, ...audioSegmentsToStop.map((seg) => seg.stopped)]);
    await callWorker({ type: 'closeAll' });
  } finally {
    await callWorker({ type: 'closeAll' }).catch(() => {});
    for (const t of active.stream.getTracks()) t.stop();
    await active.audioCtx.close().catch(() => {});
  }

  return {
    lectureId: active.lectureId,
    durationSec: Math.max(1, Math.round((Date.now() - active.startedAtMs) / 1000)),
    audioSegments: active.audioSegments,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START_CAPTURE') {
    startCapture(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP_CAPTURE') {
    stopCapture()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
});
