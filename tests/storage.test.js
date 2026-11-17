import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/shared/storage.js';
import {
  writeLectureFile,
  writeLectureJson,
  readLectureJson,
  listDirFiles,
  freeLectureMedia,
  deleteLectureDir,
  getLectureMediaBytes,
} from '../src/shared/opfs.js';

function makeMemoryArea() {
  const store = {};
  return {
    async get(key) {
      return typeof key === 'string' ? { [key]: store[key] } : { ...store };
    },
    async set(obj) {
      Object.assign(store, obj);
    },
  };
}

describe('storage index and crash recovery', () => {
  it('merges saved settings over defaults and upserts lectures sorted newest first', async () => {
    const s = createStorage(makeMemoryArea());
    const initial = await s.getSettings();
    assert.equal(initial.providerMode, 'cloud');
    await s.saveSettings({ providerMode: 'local', openrouterApiKey: 'sk-test' });
    const updated = await s.getSettings();
    assert.equal(updated.providerMode, 'local');
    assert.equal(updated.openrouterApiKey, 'sk-test');

    await s.upsertLecture({ id: '1', title: 'Old', createdAt: '2026-11-16T10:00:00Z', status: 'ready' });
    await s.upsertLecture({ id: '2', title: 'New', createdAt: '2026-11-17T10:00:00Z', status: 'recorded' });
    const list = await s.listLectures();
    assert.deepEqual(list.map((l) => l.id), ['2', '1']);
  });

  it('recovers stale recording lectures when no active session owns them', async () => {
    const s = createStorage(makeMemoryArea());
    await s.upsertLecture({
      id: 'crashed',
      title: 'Math',
      createdAt: '2026-11-17T08:00:00.000Z',
      startedAtMs: 1_000_000,
      lastChunkAtMs: 1_125_000,
      status: 'recording',
    });
    const recovered = await s.recoverStaleRecordings(null);
    assert.equal(recovered, 1);
    const lec = await s.getLecture('crashed');
    assert.equal(lec.status, 'recorded');
    assert.equal(lec.recoveredFromCrash, true);
    assert.equal(lec.durationSec, 125);
  });

  it('skips active lecture during recovery, tracks active session, and deletes lecture meta', async () => {
    const s = createStorage(makeMemoryArea());
    await s.setActiveSession({ lectureId: 'live' });
    assert.deepEqual(await s.getActiveSession(), { lectureId: 'live' });

    await s.upsertLecture({ id: 'live', createdAt: '2026-11-17T09:00:00Z', status: 'recording' });
    assert.equal(await s.recoverStaleRecordings('live'), 0);
    assert.equal((await s.getLecture('live')).status, 'recording');

    await s.deleteLectureMeta('live');
    assert.equal(await s.getLecture('live'), null);
  });

  it('serializes concurrent write operations so parallel upsertLecture calls preserve all entries', async () => {
    const store = {};
    const slowArea = {
      async get(key) {
        await new Promise((r) => setTimeout(r, 5));
        return typeof key === 'string' ? { [key]: store[key] } : { ...store };
      },
      async set(obj) {
        await new Promise((r) => setTimeout(r, 5));
        Object.assign(store, obj);
      },
    };
    const s = createStorage(slowArea);
    await Promise.all([
      s.upsertLecture({ id: 'a', title: 'Lecture A', createdAt: '2026-11-17T08:00:00Z', status: 'recorded' }),
      s.upsertLecture({ id: 'b', title: 'Lecture B', createdAt: '2026-11-17T09:00:00Z', status: 'recorded' }),
      s.upsertLecture({ id: 'a', status: 'ready' }),
    ]);
    const list = await s.listLectures();
    assert.deepEqual(list.map((l) => l.id), ['b', 'a']);
    assert.equal((await s.getLecture('a')).status, 'ready');
    assert.equal((await s.getLecture('a')).title, 'Lecture A');
  });
});

function notFound(msg) {
  const err = new Error(msg);
  err.name = 'NotFoundError';
  return err;
}

function makeMemoryOpfsRoot() {
  function makeDir() {
    const children = new Map();
    return {
      kind: 'directory',
      async getDirectoryHandle(name, { create = false } = {}) {
        const cur = children.get(name);
        if (cur) {
          if (cur.kind !== 'directory') throw new Error('TypeMismatchError');
          return cur;
        }
        if (!create) throw notFound(name);
        const dir = makeDir();
        children.set(name, dir);
        return dir;
      },
      async getFileHandle(name, { create = false } = {}) {
        const cur = children.get(name);
        if (cur) {
          if (cur.kind !== 'file') throw new Error('TypeMismatchError');
          return cur;
        }
        if (!create) throw notFound(name);
        let bytes = new Uint8Array();
        const fileHandle = {
          kind: 'file',
          async createWritable() {
            return {
              async write(data) {
                bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
              },
              async close() {},
            };
          },
          async getFile() {
            return {
              size: bytes.byteLength,
              async text() {
                return new TextDecoder().decode(bytes);
              },
            };
          },
        };
        children.set(name, fileHandle);
        return fileHandle;
      },
      async removeEntry(name, { recursive = false } = {}) {
        const cur = children.get(name);
        if (!cur) throw notFound(name);
        if (cur.kind === 'directory' && !recursive) throw new Error('InvalidModificationError');
        children.delete(name);
      },
      async *entries() {
        for (const entry of children.entries()) yield entry;
      },
    };
  }
  return makeDir();
}

describe('opfs lecture directory manager', () => {
  const origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    const root = makeMemoryOpfsRoot();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { storage: { getDirectory: async () => root } },
    });
  });

  afterEach(() => {
    if (origNavigator) Object.defineProperty(globalThis, 'navigator', origNavigator);
    else delete globalThis.navigator;
  });

  it('writes/reads JSON, lists files, computes bytes, frees media, and deletes dir', async () => {
    assert.equal(await readLectureJson('missing', 'notes.json'), null);
    assert.deepEqual(await listDirFiles('missing', 'audio'), []);
    assert.equal(await getLectureMediaBytes('missing'), 0);
    await freeLectureMedia('missing');

    await writeLectureJson('lec1', 'notes.json', { ok: true });
    await writeLectureFile('lec1', 'video.webm', new Uint8Array(10));
    await writeLectureFile('lec1', 'audio/001.webm', new Uint8Array(20));

    assert.deepEqual(await readLectureJson('lec1', 'notes.json'), { ok: true });
    assert.deepEqual(await listDirFiles('lec1', 'audio'), ['001.webm']);
    const beforeBytes = await getLectureMediaBytes('lec1');
    assert.ok(beforeBytes > 30);

    await freeLectureMedia('lec1');
    assert.deepEqual(await listDirFiles('lec1', 'audio'), []);
    assert.ok((await getLectureMediaBytes('lec1')) < beforeBytes);
    assert.deepEqual(await readLectureJson('lec1', 'notes.json'), { ok: true });

    await deleteLectureDir('lec1');
    assert.equal(await getLectureMediaBytes('lec1'), 0);
    assert.equal(await readLectureJson('lec1', 'notes.json'), null);
  });
});
