import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WHITEBOARD_CONFIG } from '../src/shared/constants.js';
import {
  base64ToUint8,
  computeFnv1aHash,
  computeStrokeBounds,
  createWhiteboardSettleController,
  createWhiteboardTracker,
  formatWhiteboardFilename,
  matchesWhiteboardMeeting,
  parseMeetingFilters,
  pickWhiteboardSurface,
  sampleSlidesForLlm,
  saveWhiteboardSlide,
  shouldEnableWhiteboard,
  shouldSaveWhiteboardFrame,
  uint8ToBase64,
} from '../src/shared/whiteboard.js';

describe('whiteboard meeting matching', () => {
  it('parses comma/newline filters and matches sanitized or raw tab titles case-insensitively', () => {
    assert.deepEqual(parseMeetingFilters(' Algebra, , Calculus \n '), ['algebra', 'calculus']);
    assert.equal(matchesWhiteboardMeeting('Calculus II | Microsoft Teams', 'algebra, calculus'), true);
    assert.equal(matchesWhiteboardMeeting('Distributed Systems | Microsoft Teams', 'algebra, calculus'), false);
    assert.equal(matchesWhiteboardMeeting('Calculus II | Microsoft Teams', ''), false);
  });

  it('respects explicit override before mode rules', () => {
    assert.equal(
      shouldEnableWhiteboard({ mode: 'off', tabTitle: 'Calculus', filterCsv: 'Calculus', override: true }),
      true
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'always', tabTitle: 'Calculus', filterCsv: 'Calculus', override: false }),
      false
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'match', tabTitle: 'Linear Algebra | Microsoft Teams', filterCsv: 'algebra' }),
      true
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'match', tabTitle: 'OS Lecture | Microsoft Teams', filterCsv: 'algebra' }),
      false
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'off', tabTitle: 'Linear Algebra | Microsoft Teams', filterCsv: 'algebra' }),
      false
    );
  });
});

describe('whiteboard filenames, deduplication, and binary encoding', () => {
  it('formats filenames compatible with pipeline.js timestamp parsing', () => {
    const name = formatWhiteboardFilename(3, 125.9);
    assert.equal(name, '003_125_wb.png');
    assert.equal(Number(name.split('_')[1]?.split('.')[0] || 0), 125);
  });

  it('deduplicates identical hashes and enforces cooldown and max capture cap', () => {
    const h1 = computeFnv1aHash(new Uint8Array([1, 2, 3, 4]));
    const h2 = computeFnv1aHash(new Uint8Array([1, 2, 3, 5]));
    assert.notEqual(h1, h2);

    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h1, prevHash: null, elapsedSinceLastSec: 0, savedCount: 0 }),
      true
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h1, prevHash: h1, elapsedSinceLastSec: 30, savedCount: 1 }),
      false
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h2, prevHash: h1, elapsedSinceLastSec: 5, savedCount: 1, minIntervalSec: 15 }),
      false
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h2, prevHash: h1, elapsedSinceLastSec: 20, savedCount: 50, maxCaptures: 50 }),
      false
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h2, prevHash: h1, elapsedSinceLastSec: 20, savedCount: 1, minIntervalSec: 15, maxCaptures: 50 }),
      true
    );
  });

  it('picks largest valid Whiteboard surface above minimum dimensions', () => {
    const picked = pickWhiteboardSurface([
      { kind: 'svg', width: 24, height: 24, elementCount: 2, index: 0 },
      { kind: 'canvas', width: 1200, height: 800, index: 1 },
      { kind: 'svg', width: 1400, height: 900, elementCount: 18, index: 2 },
    ]);
    assert.deepEqual(picked, { kind: 'svg', index: 2 });

    assert.equal(
      pickWhiteboardSurface([{ kind: 'svg', width: 100, height: 100, elementCount: 1, index: 0 }]),
      null
    );
  });

  it('computes padded union bounds for visible whiteboard stroke rects', () => {
    const box = computeStrokeBounds(
      [
        { left: 100, top: 80, right: 200, bottom: 140, width: 100, height: 60 },
        { left: 300, top: 200, right: 420, bottom: 260, width: 120, height: 60 },
        { left: -500, top: -500, right: -400, bottom: -400, width: 100, height: 100 },
      ],
      { width: 992, height: 1002 },
      20
    );
    assert.deepEqual(box, { x: 80, y: 60, width: 360, height: 220 });
    assert.equal(computeStrokeBounds([], { width: 992, height: 1002 }), null);
  });

  it('round-trips Uint8Array through base64 without data loss', () => {
    const orig = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const restored = base64ToUint8(uint8ToBase64(orig));
    assert.deepEqual(restored, orig);
  });
});

describe('saveWhiteboardSlide', () => {
  it('decodes base64 PNG and writes to slides/<filename>', async () => {
    const writes = [];
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await saveWhiteboardSlide(
      { lectureId: 'lec_1', filename: '001_12_wb.png', base64: uint8ToBase64(bytes) },
      async (id, relPath, data) => writes.push({ id, relPath, data })
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 'lec_1');
    assert.equal(writes[0].relPath, 'slides/001_12_wb.png');
    assert.deepEqual(writes[0].data, bytes);
  });
});

describe('createWhiteboardTracker', () => {
  it('assigns sequential filenames, deduplicates repeated frames, and enforces cap', () => {
    const tracker = createWhiteboardTracker('lec_99', { minIntervalSec: 15, maxCaptures: 2 });
    const imgA = uint8ToBase64(new Uint8Array([1, 2, 3]));
    const imgB = uint8ToBase64(new Uint8Array([1, 2, 4]));
    const imgC = uint8ToBase64(new Uint8Array([1, 2, 5]));

    assert.equal(tracker.accept('lec_other', 10, imgA), null);
    assert.equal(tracker.accept('lec_99', 10, imgA), '001_10_wb.png');
    assert.equal(tracker.accept('lec_99', 40, imgA), null);
    assert.equal(tracker.accept('lec_99', 18, imgB), null);
    assert.equal(tracker.accept('lec_99', 30, imgB), '002_30_wb.png');
    assert.equal(tracker.accept('lec_99', 60, imgC), null);
  });
});

describe('2h whiteboard settle, wipe protection, and LLM sampling', () => {
  it('supports 240 captures and 60 LLM slides in config', () => {
    assert.equal(WHITEBOARD_CONFIG.MAX_CAPTURES, 240);
    assert.equal(WHITEBOARD_CONFIG.MAX_LLM_SLIDES, 60);
    assert.equal(WHITEBOARD_CONFIG.SETTLE_IDLE_MS, 5000);
  });

  it('emits after 5s idle and flushes pending frame before full wipe or sharp stroke drop', async () => {
    const ctrl = createWhiteboardSettleController({ settleIdleMs: 5000, maxDirtyMs: 60000 });

    // Initial strokes at t=0 -> buffered, not emitted yet
    let res = await ctrl.step({
      signature: 's1',
      strokeCount: 6,
      nowMs: 0,
      renderFrame: async () => ({ base64: 'frame1', elapsedSec: 0 }),
    });
    assert.equal(res, null);

    // Unchanged at t=5000ms -> settled, emits frame1
    res = await ctrl.step({
      signature: 's1',
      strokeCount: 6,
      nowMs: 5000,
      renderFrame: async () => ({ base64: 'frame1', elapsedSec: 5 }),
    });
    assert.deepEqual(res, { base64: 'frame1', elapsedSec: 0, strokeCount: 6 });

    // New strokes at t=10000ms -> buffered
    res = await ctrl.step({
      signature: 's2',
      strokeCount: 10,
      nowMs: 10000,
      renderFrame: async () => ({ base64: 'frame2', elapsedSec: 10 }),
    });
    assert.equal(res, null);

    // Prof wipes whole board at t=12000ms -> flushes frame2 immediately, never emits blank
    res = await ctrl.step({
      signature: null,
      strokeCount: 0,
      nowMs: 12000,
      renderFrame: async () => null,
    });
    assert.deepEqual(res, { base64: 'frame2', elapsedSec: 10, strokeCount: 10 });

    // Empty board stays silent
    res = await ctrl.step({
      signature: null,
      strokeCount: 0,
      nowMs: 17000,
      renderFrame: async () => null,
    });
    assert.equal(res, null);

    // Sharp drop (< 50% of 8 strokes) flushes previous pending frame immediately
    await ctrl.step({
      signature: 's3',
      strokeCount: 8,
      nowMs: 20000,
      renderFrame: async () => ({ base64: 'frame3', elapsedSec: 20 }),
    });
    res = await ctrl.step({
      signature: 's4',
      strokeCount: 2,
      nowMs: 22000,
      renderFrame: async () => ({ base64: 'frame4', elapsedSec: 22 }),
    });
    assert.deepEqual(res, { base64: 'frame3', elapsedSec: 20, strokeCount: 8 });
  });

  it('force-flushes after maxDirtyMs during nonstop writing', async () => {
    const ctrl = createWhiteboardSettleController({ settleIdleMs: 5000, maxDirtyMs: 60000 });
    await ctrl.step({
      signature: 's1',
      strokeCount: 2,
      nowMs: 1000,
      renderFrame: async () => ({ base64: 'f1', elapsedSec: 1 }),
    });
    const res = await ctrl.step({
      signature: 's2',
      strokeCount: 5,
      nowMs: 61000,
      renderFrame: async () => ({ base64: 'f2', elapsedSec: 61 }),
    });
    assert.deepEqual(res, { base64: 'f2', elapsedSec: 61, strokeCount: 5 });
  });

  it('samples up to 60 slides chronologically keeping first and last', () => {
    const slides = Array.from({ length: 120 }, (_, i) => ({ filename: `${i}.png`, timestampSec: i * 10 }));
    const sampled = sampleSlidesForLlm(slides, 60);
    assert.equal(sampled.length, 60);
    assert.equal(sampled[0].filename, '0.png');
    assert.equal(sampled[sampled.length - 1].filename, '119.png');
    assert.equal(sampleSlidesForLlm(slides.slice(0, 20), 60).length, 20);
  });
});
