const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC_CHUNK_BYTES = 4 * 1024 * 1024;

async function crc32AndSize(data) {
  if (data instanceof Uint8Array) {
    return { crc: crc32(data), size: data.length, source: data };
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    let crc = 0;
    for (let offset = 0; offset < data.size; offset += CRC_CHUNK_BYTES) {
      const slice = data.slice(offset, Math.min(data.size, offset + CRC_CHUNK_BYTES));
      const chunk = new Uint8Array(await slice.arrayBuffer());
      crc = crc32(chunk, crc);
    }
    return { crc, size: data.size, source: data };
  }
  const bytes = new Uint8Array(data);
  return { crc: crc32(bytes), size: bytes.length, source: bytes };
}

function makeLocalAndCentralHeaders(nameBytes, crc, size, offset) {
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
  lv.setUint16(8, 0, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, size, true);
  lv.setUint32(22, size, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  const cd = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0800, true); // UTF-8 filename flag
  cv.setUint32(16, crc, true);
  cv.setUint32(20, size, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, offset, true);
  cd.set(nameBytes, 46);

  return { local, cd };
}

function makeEocd(entryCount, centralSize, offset) {
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entryCount, true);
  ev.setUint16(10, entryCount, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return eocd;
}

/**
 * Build an uncompressed (STORE) ZIP archive in memory.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
export function buildStoreZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const { local, cd } = makeLocalAndCentralHeaders(nameBytes, crc32(data), data.length, offset);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const eocd = makeEocd(entries.length, centralSize, offset);
  const out = new Uint8Array(offset + centralSize + eocd.length);
  let pos = 0;
  for (const p of [...parts, ...central, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * Build an uncompressed (STORE) ZIP Blob from Uint8Array or Blob/File entries without
 * copying large media files into a single contiguous Uint8Array.
 * @param {Array<{ name: string, data: Uint8Array | Blob }>} entries
 * @returns {Promise<Blob>}
 */
export async function buildStoreZipBlob(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const { crc, size, source } = await crc32AndSize(entry.data);
    const { local, cd } = makeLocalAndCentralHeaders(nameBytes, crc, size, offset);
    parts.push(local, source);
    central.push(cd);
    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const eocd = makeEocd(entries.length, centralSize, offset);
  return new Blob([...parts, ...central, eocd], { type: 'application/octet-stream' });
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DEFLATE decompression is not supported in this runtime.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse a ZIP/MyTems archive (Blob or Uint8Array) and return lazy entry readers.
 * Supports STORE (method 0) and DEFLATE (method 8).
 * @param {Blob | Uint8Array} input
 * @returns {Promise<Array<{ name: string, size: number, compressedSize: number, method: number, readBytes: () => Promise<Uint8Array>, readBlob: () => Promise<Blob> }>>}
 */
export async function readZipEntries(input) {
  const isBlob = typeof Blob !== 'undefined' && input instanceof Blob;
  const totalSize = isBlob ? input.size : input.length;
  if (totalSize < 22) throw new Error('Invalid archive: file too small.');

  const sliceBytes = async (start, end) => {
    if (isBlob) return new Uint8Array(await input.slice(start, end).arrayBuffer());
    return input.subarray(start, end);
  };

  const tailStart = Math.max(0, totalSize - 65557);
  const tail = await sliceBytes(tailStart, totalSize);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('Invalid archive: central directory not found.');

  const totalEntries = tailView.getUint16(eocdPos + 10, true);
  const cdSize = tailView.getUint32(eocdPos + 12, true);
  const cdOffset = tailView.getUint32(eocdPos + 16, true);
  if (cdOffset + cdSize > totalSize) throw new Error('Invalid archive: corrupt central directory.');

  const cd = await sliceBytes(cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder();
  const entries = [];
  let pos = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cd.length || cdView.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('Invalid archive: corrupt central directory header.');
    }
    const method = cdView.getUint16(pos + 10, true);
    const compressedSize = cdView.getUint32(pos + 20, true);
    const size = cdView.getUint32(pos + 24, true);
    const nameLen = cdView.getUint16(pos + 28, true);
    const extraLen = cdView.getUint16(pos + 30, true);
    const commentLen = cdView.getUint16(pos + 32, true);
    const localOffset = cdView.getUint32(pos + 42, true);
    const name = dec.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    const readPayloadSlice = async () => {
      const lh = await sliceBytes(localOffset, localOffset + 30);
      const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
      if (lv.getUint32(0, true) !== 0x04034b50) {
        throw new Error(`Invalid archive: corrupt local header for ${name}`);
      }
      const lNameLen = lv.getUint16(26, true);
      const lExtraLen = lv.getUint16(28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compressedSize;
      return { dataStart, dataEnd };
    };

    const readBytes = async () => {
      const { dataStart, dataEnd } = await readPayloadSlice();
      const raw = await sliceBytes(dataStart, dataEnd);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    };

    const readBlob = async () => {
      if (method === 0 && isBlob) {
        const { dataStart, dataEnd } = await readPayloadSlice();
        return input.slice(dataStart, dataEnd);
      }
      return new Blob([await readBytes()]);
    };

    entries.push({ name, size, compressedSize, method, readBytes, readBlob });
  }

  return entries;
}
