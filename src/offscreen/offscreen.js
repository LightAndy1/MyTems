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

function startAudioSegment(lectureId, audioStream, startedAtMs, index) {
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
  const stopped = new Promise((resolve) => {
    recorder.onstop = async () => {
      await writeChain;
      await callWorker({ type: 'close', lectureId, relPath });
      resolve();
    };
  });
  recorder.start(RECORDING_CONFIG.TIMESLICE_MS);
  session.audioSegments.push({ filename: relPath, offsetSec });
  return { recorder, stopped };
}

async function startCapture({ lectureId, streamId }) {
  if (session) throw new Error('Capture already active');
  const stream = await navigator.mediaDevices.getUserMedia({
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

  const audioCtx = new AudioContext();
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

  const videoStopped = new Promise((resolve) => {
    videoRecorder.onstop = async () => {
      await videoChain;
      await callWorker({ type: 'close', lectureId, relPath: 'video.webm' });
      resolve();
    };
  });

  session = {
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
    rolloverTimer: null,
  };

  session.currentAudio = startAudioSegment(lectureId, audioStream, startedAtMs, 0);
  videoRecorder.start(RECORDING_CONFIG.TIMESLICE_MS);

  session.rolloverTimer = setInterval(() => {
    if (!session) return;
    const prev = session.currentAudio;
    session.segmentIndex += 1;
    session.currentAudio = startAudioSegment(
      lectureId,
      audioStream,
      startedAtMs,
      session.segmentIndex
    );
    setTimeout(() => {
      if (prev?.recorder.state === 'recording') prev.recorder.stop();
    }, RECORDING_CONFIG.AUDIO_OVERLAP_MS);
  }, RECORDING_CONFIG.AUDIO_SEGMENT_MS);

  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    stopCapture().then((res) => {
      if (res) {
        chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED_EXTERNALLY', ...res }).catch(() => {});
      }
    });
  });
}

async function stopCapture() {
  if (!session) return null;
  const active = session;
  session = null;
  clearInterval(active.rolloverTimer);

  if (active.videoRecorder.state === 'recording') active.videoRecorder.stop();
  if (active.currentAudio?.recorder.state === 'recording') active.currentAudio.recorder.stop();

  await Promise.all([active.videoStopped, active.currentAudio?.stopped]);
  await callWorker({ type: 'closeAll' });

  for (const t of active.stream.getTracks()) t.stop();
  await active.audioCtx.close().catch(() => {});

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
