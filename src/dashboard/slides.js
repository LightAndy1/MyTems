import { SLIDE_CONFIG } from '../shared/constants.js';
import { listDirFiles, writeLectureFile } from '../shared/opfs.js';

export function computeMeanPixelDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
  }
  return sum / pixels;
}

export function shouldCaptureSlide({
  diff,
  elapsedSec,
  slideCount,
  threshold = SLIDE_CONFIG.DIFF_THRESHOLD,
  minCooldownSec = SLIDE_CONFIG.MIN_COOLDOWN_SEC,
  maxSlides = SLIDE_CONFIG.MAX_SLIDES,
}) {
  if (slideCount >= maxSlides) return false;
  if (slideCount === 0) return true;
  return diff >= threshold && elapsedSec >= minCooldownSec;
}

function seekVideo(video, sec) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Video seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = sec;
  });
}

async function encodeFrameJpeg(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', SLIDE_CONFIG.JPEG_QUALITY));
  if (!blob) throw new Error('Failed to encode slide JPEG');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function captureCurrentVideoFrame(videoEl, lectureId, timestampSec) {
  const existing = await listDirFiles(lectureId, 'slides');
  const nextIdx = String(existing.length + 1).padStart(3, '0');
  const secInt = Math.max(0, Math.floor(timestampSec));
  const filename = `${nextIdx}_${secInt}.jpg`;
  const jpeg = await encodeFrameJpeg(videoEl);
  await writeLectureFile(lectureId, `slides/${filename}`, jpeg);
  return { filename, timestampSec: secInt };
}

export async function extractSlidesFromVideo(videoFile, lectureId, onProgress = () => {}) {
  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;

  const cmpCanvas = document.createElement('canvas');
  cmpCanvas.width = SLIDE_CONFIG.COMPARE_WIDTH;
  cmpCanvas.height = SLIDE_CONFIG.COMPARE_HEIGHT;
  const cmpCtx = cmpCanvas.getContext('2d', { willReadFrequently: true });

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not decode video.webm'));
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration === 0) return [];

    const slides = [];
    let prevPixels = null;
    let lastCaptureSec = -SLIDE_CONFIG.MIN_COOLDOWN_SEC;

    for (let t = 1; t < duration; t += SLIDE_CONFIG.STEP_SEC) {
      await seekVideo(video, t);
      cmpCtx.drawImage(video, 0, 0, cmpCanvas.width, cmpCanvas.height);
      const curr = cmpCtx.getImageData(0, 0, cmpCanvas.width, cmpCanvas.height).data;
      const diff = prevPixels ? computeMeanPixelDiff(prevPixels, curr) : 1;

      if (shouldCaptureSlide({ diff, elapsedSec: t - lastCaptureSec, slideCount: slides.length })) {
        const idx = String(slides.length + 1).padStart(3, '0');
        const secInt = Math.floor(t);
        const filename = `${idx}_${secInt}.jpg`;
        const jpeg = await encodeFrameJpeg(video);
        await writeLectureFile(lectureId, `slides/${filename}`, jpeg);
        slides.push({ filename, timestampSec: secInt });
        prevPixels = curr;
        lastCaptureSec = t;
      }
      onProgress(Math.min(1, t / duration));
      if (slides.length >= SLIDE_CONFIG.MAX_SLIDES) break;
    }
    onProgress(1);
    return slides;
  } finally {
    URL.revokeObjectURL(url);
  }
}
