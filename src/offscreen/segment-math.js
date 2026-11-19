import { RECORDING_CONFIG } from '../shared/constants.js';

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

export function buildTabCaptureConstraints(streamId, recordScreen = true, videoConfig = RECORDING_CONFIG) {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        googDisableLocalEcho: false,
      },
    },
    video: recordScreen
      ? {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
            maxWidth: videoConfig.MAX_WIDTH,
            maxHeight: videoConfig.MAX_HEIGHT,
            maxFrameRate: videoConfig.MAX_FPS,
          },
        }
      : false,
  };
}
