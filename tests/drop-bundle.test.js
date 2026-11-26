import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDropManifest,
  exportDropBundleBlob,
  importDropFromEntries,
  inspectPartsForDrop,
  parseDropBundle,
  planDuplicateResolution,
} from '../src/shared/drop-bundle.js';

function createMemoryFs(initial = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, v instanceof Uint8Array ? v : new TextEncoder().encode(v));
  }

  return {
    store,
    async readLectureFile(id, relPath) {
      const key = `${id}/${relPath}`;
      if (!store.has(key)) {
        const err = new Error(`Not found: ${key}`);
        err.name = 'NotFoundError';
        throw err;
      }
      const bytes = store.get(key);
      return new Blob([bytes]);
    },
    async listDirFiles(id, subDir) {
      const prefix = `${id}/${subDir}/`;
      const out = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          out.push(key.slice(prefix.length));
        }
      }
      return out.sort();
    },
    async writeLectureFile(id, relPath, data) {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
      store.set(`${id}/${relPath}`, bytes);
    },
  };
}

describe('.mytems drop bundle export and import', () => {
  it('inspects layers, builds selective manifest, and roundtrips .mytems blob', async () => {
    const fs = createMemoryFs({
      'lec-1/video.webm': new Uint8Array([1, 2, 3, 4, 5]),
      'lec-1/audio/seg-001.webm': new Uint8Array([9, 8, 7]),
      'lec-1/slides/001.jpg': new Uint8Array([10, 20]),
      'lec-1/transcript.json': JSON.stringify({ segments: [{ startSec: 0, text: 'hello' }] }),
      'lec-1/notes.json': JSON.stringify({ summary: 'notes' }),
    });

    const parts = [{ id: 'lec-1', title: 'Distributed Systems Pt 1', lessonId: 'lesson_a', status: 'ready' }];
    const inspected = await inspectPartsForDrop(parts, fs);

    assert.equal(inspected[0].layers.video.bytes, 5);
    assert.equal(inspected[0].layers.audio.bytes, 3);
    assert.equal(inspected[0].layers.slides.bytes, 2);

    const manifestOnlyVideoNotes = buildDropManifest(inspected, ['lec-1'], ['video', 'notes']);
    assert.equal(manifestOnlyVideoNotes.lectures[0].files.length, 2);
    assert.equal(manifestOnlyVideoNotes.totalBytes, 5 + fs.store.get('lec-1/notes.json').length);

    const exported = await exportDropBundleBlob(inspected, ['lec-1'], ['video', 'slides', 'notes'], fs);
    assert.ok(exported.filename.endsWith('.mytems'));

    const parsed = await parseDropBundle(exported.blob);
    assert.equal(parsed.manifest.totalBytes, exported.manifest.totalBytes);
    assert.deepEqual(parsed.manifest.includedLayers, ['video', 'slides', 'notes']);

    const destFs = createMemoryFs();
    const upserted = [];
    const res = await importDropFromEntries(
      parsed.manifest,
      parsed.entryByName,
      [],
      'copy',
      {
        writeLectureFile: destFs.writeLectureFile,
        upsertLecture: async (m) => upserted.push(m),
      }
    );

    assert.equal(res.imported.length, 1);
    assert.equal(res.imported[0].status, 'ready');
    assert.deepEqual(destFs.store.get('lec-1/video.webm'), new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(destFs.store.has('lec-1/audio/seg-001.webm'), false);
  });

  it('handles duplicate resolution strategies and preserves multi-part lesson grouping on copy', () => {
    const incoming = [
      { meta: { id: 'p1', title: 'Part 1', lessonId: 'lesson_orig' }, files: [{ relPath: 'video.webm', size: 10 }] },
      { meta: { id: 'p2', title: 'Part 2', lessonId: 'lesson_orig' }, files: [{ relPath: 'notes.json', size: 20 }] },
    ];
    const existing = [{ id: 'p1' }, { id: 'p2' }];

    const skipped = planDuplicateResolution(incoming, existing, 'skip');
    assert.equal(skipped.every((p) => p.action === 'skip'), true);

    const copied = planDuplicateResolution(incoming, existing, 'copy');
    assert.notEqual(copied[0].targetMeta.id, 'p1');
    assert.notEqual(copied[1].targetMeta.id, 'p2');
    assert.equal(copied[0].targetMeta.lessonId, copied[1].targetMeta.lessonId);
    assert.notEqual(copied[0].targetMeta.lessonId, 'lesson_orig');
    assert.equal(copied[0].targetMeta.status, 'recorded');
    assert.equal(copied[1].targetMeta.status, 'ready');
  });
});
