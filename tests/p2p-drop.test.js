import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDropReceiver,
  createDropSender,
  formatBytes,
  generateDropCode,
  normalizeDropCode,
} from '../src/shared/p2p-drop.js';

function createMockRelay() {
  const topics = new Map();

  function getTopic(url) {
    const clean = url.replace(/\/sse\?since=all$/, '');
    if (!topics.has(clean)) topics.set(clean, { messages: [], listeners: new Set() });
    return topics.get(clean);
  }

  async function fetchImpl(url, opts = {}) {
    const topic = getTopic(url);
    const envelope = JSON.stringify({ event: 'message', message: opts.body });
    topic.messages.push(envelope);
    for (const fn of topic.listeners) fn({ data: envelope });
    return { ok: true, status: 200 };
  }

  class MockEventSource {
    constructor(url) {
      this.topic = getTopic(url);
      this.handlers = new Set();
      this.listener = (ev) => {
        for (const h of this.handlers) h(ev);
      };
      this.topic.listeners.add(this.listener);
      queueMicrotask(() => {
        for (const data of this.topic.messages) {
          this.listener({ data });
        }
      });
    }
    addEventListener(type, fn) {
      if (type === 'message') this.handlers.add(fn);
    }
    close() {
      this.topic.listeners.delete(this.listener);
      this.handlers.clear();
    }
  }

  return { fetchImpl, MockEventSource };
}

function createMockPeerPair() {
  const pcs = [];
  class MockPeerConnection {
    constructor() {
      this.remoteDescription = null;
      this.onicecandidate = null;
      this.ondatachannel = null;
      this.bufferedAmount = 0;
      pcs.push(this);
    }
    createDataChannel(label) {
      const dc = {
        label,
        onopen: null,
        onmessage: null,
        onerror: null,
        bufferedAmount: 0,
        addEventListener() {},
        removeEventListener() {},
        send: (data) => {
          const peer = pcs.find((p) => p !== this);
          queueMicrotask(() => {
            peer?._remoteDc?.onmessage?.({ data });
          });
        },
        close() {},
      };
      this._localDc = dc;
      return dc;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'mock-offer' };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'mock-answer' };
    }
    async setLocalDescription(desc) {
      this.localDescription = desc;
    }
    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
      if (desc.type === 'answer') {
        const receiver = pcs.find((p) => p !== this);
        const remoteDc = {
          binaryType: 'arraybuffer',
          onmessage: null,
          onerror: null,
          close() {},
        };
        receiver._remoteDc = remoteDc;
        receiver.ondatachannel?.({ channel: remoteDc });
        queueMicrotask(() => this._localDc?.onopen?.());
      }
    }
    async addIceCandidate() {}
    close() {}
  }
  return MockPeerConnection;
}

describe('P2P Drop Code signaling and chunked transfer', () => {
  it('generates, normalizes, and formats drop codes and byte sizes', () => {
    const code = generateDropCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const norm = normalizeDropCode(`  ${code.toLowerCase()} `);
    assert.equal(norm.formatted, code);
    assert.throws(() => normalizeDropCode('abc'));
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });

  it('previews manifest size before pull and transfers chunked files P2P', async () => {
    const { fetchImpl, MockEventSource } = createMockRelay();
    const MockPC = createMockPeerPair();

    const videoBytes = new Uint8Array(140_000);
    for (let i = 0; i < videoBytes.length; i++) videoBytes[i] = i % 251;
    const notesBytes = new TextEncoder().encode('{"summary":"ok"}');

    const manifest = {
      schemaVersion: 1,
      includedLayers: ['video', 'notes'],
      totalBytes: videoBytes.length + notesBytes.length,
      lectures: [
        {
          meta: { id: 'lec-9', title: 'Algorithms' },
          files: [
            { relPath: 'video.webm', layer: 'video', size: videoBytes.length },
            { relPath: 'notes.json', layer: 'notes', size: notesBytes.length },
          ],
        },
      ],
    };

    const sender = await createDropSender({
      manifest,
      readPartFile: async (_id, relPath) => (relPath === 'video.webm' ? new Blob([videoBytes]) : new Blob([notesBytes])),
      relayUrl: 'https://mock.relay',
      fetchImpl,
      EventSourceImpl: MockEventSource,
      PeerConnectionImpl: MockPC,
    });

    const receiver = createDropReceiver({
      code: sender.code,
      relayUrl: 'https://mock.relay',
      fetchImpl,
      EventSourceImpl: MockEventSource,
      PeerConnectionImpl: MockPC,
    });

    const preview = await receiver.waitForManifest();
    assert.equal(preview.manifest.totalBytes, videoBytes.length + notesBytes.length);

    const receivedFiles = new Map();
    let currentChunks = [];
    await receiver.pull({
      onFileStart: ({ relPath }) => {
        currentChunks = [];
        receivedFiles.set(relPath, currentChunks);
      },
      onFileChunk: (_file, chunk) => {
        currentChunks.push(chunk);
      },
    });

    const gotVideo = new Uint8Array(await new Blob(receivedFiles.get('video.webm')).arrayBuffer());
    const gotNotes = new Uint8Array(await new Blob(receivedFiles.get('notes.json')).arrayBuffer());
    assert.deepEqual(gotVideo, videoBytes);
    assert.deepEqual(gotNotes, notesBytes);

    receiver.close();
    sender.close();
  });
});
