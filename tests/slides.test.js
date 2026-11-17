import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMeanPixelDiff, shouldCaptureSlide } from '../src/dashboard/slides.js';

describe('slide frame diffing', () => {
  it('computes normalized mean RGB pixel difference', () => {
    const a = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]);
    const b = new Uint8ClampedArray([255, 255, 255, 255, 100, 100, 100, 255]);
    assert.equal(computeMeanPixelDiff(a, a), 0);
    assert.ok(Math.abs(computeMeanPixelDiff(a, b) - 0.5) < 1e-6);
  });

  it('enforces threshold, cooldown, and max slide cap', () => {
    assert.equal(shouldCaptureSlide({ diff: 0.02, elapsedSec: 12, slideCount: 1 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 4, slideCount: 1 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 10, slideCount: 50 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 10, slideCount: 5 }), true);
  });
});
