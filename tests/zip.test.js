import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStoreZip } from '../src/shared/zip.js';

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
});
