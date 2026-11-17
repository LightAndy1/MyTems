export function formatSegmentFilename(index) {
  return `audio/${String(index).padStart(3, '0')}.webm`;
}

export function computeOffsetSec(startedAtMs, segmentStartMs) {
  return Math.max(0, Number(((segmentStartMs - startedAtMs) / 1000).toFixed(2)));
}

export function pickVideoMimeType(isTypeSupported) {
  for (const mime of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']) {
    if (isTypeSupported(mime)) return mime;
  }
  return 'video/webm';
}
