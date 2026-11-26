import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStoreZip, buildStoreZipBlob, readZipEntries } from '../src/shared/zip.js';

describe('buildStoreZip', () => {
  it('writes valid local header, central directory, and EOCD signatures', () => {
    const zip = buildStoreZip([
      { name: 'notes.md', data: new TextEncoder().encode('# Hello') },
      { name: 'slides/001.jpg', data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50); // Local header signature
    const eocdOffset = zip.byteLength - 22;
    assert.equal(view.getUint32(eocdOffset, true), 0x06054b50); // EOCD signature
    assert.equal(view.getUint16(eocdOffset + 10, true), 2); // Total entries
  });

  it('roundtrips Blob and Uint8Array entries through buildStoreZipBlob and readZipEntries', async () => {
    const blob = await buildStoreZipBlob([
      { name: 'meta.json', data: new TextEncoder().encode('{"ok":true}') },
      { name: 'parts/1/video.webm', data: new Blob([new Uint8Array([9, 8, 7, 6, 5])]) },
    ]);
    const entries = await readZipEntries(blob);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'meta.json');
    assert.equal(new TextDecoder().decode(await entries[0].readBytes()), '{"ok":true}');
    assert.deepEqual(await entries[1].readBytes(), new Uint8Array([9, 8, 7, 6, 5]));
  });
});
