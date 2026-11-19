import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportZipPayload,
  hasAudioOnlyMedia,
  resolveLectureMediaDownload,
} from '../src/shared/export.js';

function makeMockFs(tree) {
  const notFound = (path) => Object.assign(new Error(`Not found: ${path}`), { name: 'NotFoundError' });
  return {
    async readLectureFile(id, relPath) {
      const data = tree[id]?.files?.[relPath];
      if (!data) throw notFound(`${id}/${relPath}`);
      return new Blob([data]);
    },
    async listDirFiles(id, subDir) {
      const files = tree[id]?.files || {};
      const prefix = `${subDir}/`;
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
    },
    async readLectureJson(id, relPath) {
      return tree[id]?.json?.[relPath] ?? null;
    },
  };
}

function readZipEntryNames(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const eocdOffset = zipBytes.byteLength - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  const count = view.getUint16(eocdOffset + 10, true);
  let pos = view.getUint32(eocdOffset + 16, true);
  const dec = new TextDecoder();
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(pos, true), 0x02014b50);
    const nameLen = view.getUint16(pos + 28, true);
    names.push(dec.decode(zipBytes.subarray(pos + 46, pos + 46 + nameLen)));
    pos += 46 + nameLen;
  }
  return names;
}

const SAMPLE_NOTES = {
  summary: 'Discussed project milestones.',
  chapters: [{ title: 'Intro', startSec: 0, endSec: 60, bullets: ['Kickoff'], formulas: [], slideRefs: [] }],
  examRadar: [],
  definitions: [],
};

describe('audio-only download and export ZIP helpers', () => {
  it('downloads video when video.webm exists and ignores audio segments', async () => {
    const deps = makeMockFs({
      l1: {
        files: {
          'video.webm': new Uint8Array([1, 2, 3]),
          'audio/000.webm': new Uint8Array([4, 5]),
        },
      },
    });
    const lec = { id: 'l1', title: 'Weekly Sync', createdAt: '2026-11-19T10:00:00.000Z' };
    const res = await resolveLectureMediaDownload('l1', lec, { partIndex: 1, totalParts: 1 }, deps);
    assert.equal(res.kind, 'video');
    assert.match(res.filename, /_Weekly_Sync\.webm$/);
  });

  it('downloads single audio segment directly and bundles multi-segment audio as ZIP', async () => {
    const lec = { id: 'l1', title: 'Standup', createdAt: '2026-11-19T10:00:00.000Z', recordScreen: false };
    const singleDeps = makeMockFs({
      l1: { files: { 'audio/000.webm': new Uint8Array([9, 8, 7]) } },
    });
    const single = await resolveLectureMediaDownload('l1', lec, { partIndex: 1, totalParts: 1 }, singleDeps);
    assert.equal(single.kind, 'audio');
    assert.match(single.filename, /_Standup_audio\.webm$/);

    const multiDeps = makeMockFs({
      l1: {
        files: {
          'audio/000.webm': new Uint8Array([1, 2]),
          'audio/001.webm': new Uint8Array([3, 4]),
        },
      },
    });
    const multi = await resolveLectureMediaDownload('l1', lec, { partIndex: 1, totalParts: 1 }, multiDeps);
    assert.equal(multi.kind, 'audio-zip');
    assert.match(multi.filename, /_Standup_audio\.zip$/);
    const zipBytes = new Uint8Array(await multi.blob.arrayBuffer());
    assert.deepEqual(readZipEntryNames(zipBytes), ['000.webm', '001.webm']);

    const emptyDeps = makeMockFs({ l1: { files: {} } });
    assert.equal(await resolveLectureMediaDownload('l1', lec, undefined, emptyDeps), null);
  });

  it('includes audio in export ZIP only for parts without video.webm and allows export without notes', async () => {
    const deps = makeMockFs({
      audioPart: {
        files: {
          'audio/000.webm': new Uint8Array([10, 20]),
          'slides/001_5.jpg': new Uint8Array([30, 40]),
        },
        json: {
          'transcript.json': { segments: [{ startSec: 5, speaker: 'Ana', text: 'Hello team' }] },
        },
      },
      videoPart: {
        files: {
          'video.webm': new Uint8Array([1, 2]),
          'audio/000.webm': new Uint8Array([99, 99]),
          'slides/001_12.jpg': new Uint8Array([50, 60]),
        },
      },
    });

    const pAudio = { id: 'audioPart', title: 'Sync Pt1', createdAt: '2026-11-19T10:00:00.000Z', recordScreen: false };
    const pVideo = { id: 'videoPart', title: 'Sync Pt2', createdAt: '2026-11-19T11:00:00.000Z', recordScreen: true };

    // Single audio-only lecture without notes: includes slides, audio, transcript.txt
    const noNotes = await buildExportZipPayload({ parts: [pAudio], notes: null, deps });
    assert.match(noNotes.filename, /_Sync_Pt1\.zip$/);
    assert.deepEqual(readZipEntryNames(noNotes.zipBytes), [
      'slides/001_5.jpg',
      'audio/000.webm',
      'transcript.txt',
    ]);

    // Single video lecture with notes: excludes audio
    const withVideo = await buildExportZipPayload({ parts: [pVideo], notes: SAMPLE_NOTES, deps });
    assert.match(withVideo.filename, /_Sync_Pt2_notion\.zip$/);
    assert.deepEqual(readZipEntryNames(withVideo.zipBytes), ['notes.md', 'slides/001_12.jpg']);

    // Multi-part lesson mixing audio-only + video parts with notes
    const lessonZip = await buildExportZipPayload({
      parts: [pAudio, pVideo],
      isMultiPart: true,
      lessonTitle: 'Weekly Sync',
      lessonSubject: 'Sync',
      notes: SAMPLE_NOTES,
      deps,
    });
    assert.match(lessonZip.filename, /_Weekly_Sync_lesson_notion\.zip$/);
    assert.deepEqual(readZipEntryNames(lessonZip.zipBytes), [
      'notes.md',
      'slides/pt1_001_5.jpg',
      'audio/pt1_000.webm',
      'slides/pt2_001_12.jpg',
    ]);

    // Video-only recording with no slides/transcript/notes returns null
    const emptyVideo = await buildExportZipPayload({
      parts: [{ id: 'vOnly', title: 'Raw', createdAt: '2026-11-19T10:00:00.000Z' }],
      notes: null,
      deps: makeMockFs({ vOnly: { files: { 'video.webm': new Uint8Array([1]) } } }),
    });
    assert.equal(emptyVideo, null);
    assert.equal(await hasAudioOnlyMedia([pAudio], deps), true);
    assert.equal(await hasAudioOnlyMedia([pVideo], deps), false);
  });
});
