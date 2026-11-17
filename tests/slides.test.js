import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMeanPixelDiff,
  shouldCaptureSlide,
  resolveVideoDuration,
} from '../src/dashboard/slides.js';

describe('slide frame diffing', () => {
  it('computes normalized mean RGB pixel difference', () => {
    const a = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]);
    const b = new Uint8ClampedArray([255, 255, 255, 255, 100, 100, 100, 255]);
    assert.equal(computeMeanPixelDiff(a, a), 0);
    assert.ok(Math.abs(computeMeanPixelDiff(a, b) - 0.5) < 1e-6);
  });

  it('enforces threshold, cooldown, max slide cap, and explicit first-frame flag', () => {
    assert.equal(shouldCaptureSlide({ diff: 0.02, elapsedSec: 12, slideCount: 1 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 4, slideCount: 1 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 10, slideCount: 50 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 10, slideCount: 5 }), true);
    assert.equal(shouldCaptureSlide({ diff: 0, elapsedSec: 0, slideCount: 2, isFirst: true }), true);
    assert.equal(shouldCaptureSlide({ diff: 0, elapsedSec: 0, slideCount: 50, isFirst: true }), false);
  });
});

describe('resolveVideoDuration', () => {
  it('returns finite positive video.duration directly without seeking', async () => {
    let seeks = 0;
    const dur = await resolveVideoDuration({ duration: 42.5 }, async () => { seeks += 1; }, 10);
    assert.equal(dur, 42.5);
    assert.equal(seeks, 0);
  });

  it('probes Infinity duration by seeking to 1e10 then back to 0 when resolved', async () => {
    const seeks = [];
    const video = { duration: Infinity };
    const seekFn = async (v, sec) => {
      seeks.push(sec);
      if (sec === 1e10) v.duration = 95.2;
    };
    const dur = await resolveVideoDuration(video, seekFn, 10);
    assert.equal(dur, 95.2);
    assert.deepEqual(seeks, [1e10, 0]);
  });

  it('falls back to fallbackDurationSec when duration remains Infinity or non-finite', async () => {
    const seeks = [];
    const video = { duration: Infinity };
    const dur = await resolveVideoDuration(video, async (_v, sec) => { seeks.push(sec); }, 180);
    assert.equal(dur, 180);
    assert.deepEqual(seeks, [1e10]);

    assert.equal(await resolveVideoDuration({ duration: NaN }, async () => {}, -5), 0);
  });
});
