import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSegmentFilename,
  computeOffsetSec,
  pickVideoMimeType,
} from '../src/offscreen/segment-math.js';

describe('recorder segment helpers', () => {
  it('formats zero-padded audio segment filenames', () => {
    assert.equal(formatSegmentFilename(0), 'audio/000.webm');
    assert.equal(formatSegmentFilename(12), 'audio/012.webm');
  });

  it('computes non-negative segment offset seconds', () => {
    assert.equal(computeOffsetSec(10_000, 10_000), 0);
    assert.equal(computeOffsetSec(10_000, 609_700), 599.7);
  });

  it('prefers VP9 then VP8 then generic webm', () => {
    assert.equal(
      pickVideoMimeType((m) => m.includes('vp9')),
      'video/webm;codecs=vp9,opus'
    );
    assert.equal(
      pickVideoMimeType((m) => m.includes('vp8')),
      'video/webm;codecs=vp8,opus'
    );
    assert.equal(pickVideoMimeType(() => false), 'video/webm');
  });
});
