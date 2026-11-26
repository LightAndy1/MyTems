const DROP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function generateDropCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += DROP_CODE_ALPHABET[bytes[i] % DROP_CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normalizeDropCode(raw) {
  const clean = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) {
    throw new Error('Drop code must be 8 characters (e.g. BUBA-4829).');
  }
  return { clean, formatted: `${clean.slice(0, 4)}-${clean.slice(4)}` };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function makePeerId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildTopicUrl(relayUrl, cleanCode) {
  const base = String(relayUrl || 'https://ntfy.sh').replace(/\/+$/, '');
  return `${base}/mytems-drop-${cleanCode}`;
}

async function postSignal(topicUrl, payload, fetchImpl = fetch) {
  const res = await fetchImpl(topicUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Relay error (${res.status}) while posting signal.`);
  }
}

function subscribeSignals(topicUrl, onSignal, EventSourceImpl = EventSource) {
  const es = new EventSourceImpl(`${topicUrl}/sse?since=all`);
  es.addEventListener('message', (ev) => {
    try {
      const envelope = JSON.parse(ev.data);
      if (envelope?.event !== 'message' || typeof envelope.message !== 'string') return;
      const signal = JSON.parse(envelope.message);
      if (signal && typeof signal === 'object') onSignal(signal);
    } catch {
      // Ignore non-JSON relay keepalives or malformed frames.
    }
  });
  return es;
}

async function waitForBufferDrain(dc) {
  if (dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;
  await new Promise((resolve) => {
    dc.bufferedAmountLowThreshold = Math.floor(MAX_BUFFERED_AMOUNT / 2);
    const onLow = () => {
      dc.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', onLow);
  });
}

async function streamFileOverChannel(dc, lectureId, relPath, file, onChunkSent) {
  const size = typeof file.size === 'number' ? file.size : file.byteLength || 0;
  dc.send(JSON.stringify({ type: 'file-start', lectureId, relPath, size }));

  if (typeof file.slice === 'function') {
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      await waitForBufferDrain(dc);
      const slice = file.slice(offset, Math.min(size, offset + CHUNK_SIZE));
      const buf = await slice.arrayBuffer();
      dc.send(buf);
      onChunkSent?.(buf.byteLength);
    }
  } else {
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      await waitForBufferDrain(dc);
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_SIZE));
      dc.send(chunk);
      onChunkSent?.(chunk.byteLength);
    }
  }

  dc.send(JSON.stringify({ type: 'file-end', lectureId, relPath }));
}

/**
 * Create a live P2P Drop sender session bound to an 8-char Drop Code.
 * Streams files directly from OPFS to any colleague who enters the code.
 */
export async function createDropSender({
  manifest,
  readPartFile,
  relayUrl = 'https://ntfy.sh',
  onPeerUpdate,
  fetchImpl = fetch,
  EventSourceImpl = EventSource,
  PeerConnectionImpl = RTCPeerConnection,
}) {
  const code = generateDropCode();
  const { clean } = normalizeDropCode(code);
  const topicUrl = buildTopicUrl(relayUrl, clean);
  const senderId = makePeerId();
  const peers = new Map();
  let closed = false;

  const emitPeerState = () => {
    const list = [...peers.entries()].map(([peerId, p]) => ({
      peerId,
      state: p.state,
      sentBytes: p.sentBytes,
    }));
    onPeerUpdate?.(list);
  };

  await postSignal(
    topicUrl,
    { type: 'manifest', senderId, manifest },
    fetchImpl
  );

  const es = subscribeSignals(
    topicUrl,
    async (msg) => {
      if (closed || msg.senderId !== senderId) return;

      if (msg.type === 'join' && msg.peerId && !peers.has(msg.peerId)) {
        const peerId = msg.peerId;
        const pc = new PeerConnectionImpl({ iceServers: DEFAULT_ICE_SERVERS });
        const dc = pc.createDataChannel('mytems-drop', { ordered: true });
        const peerState = { pc, dc, state: 'connecting', sentBytes: 0, pendingIce: [] };
        peers.set(peerId, peerState);
        emitPeerState();

        pc.onicecandidate = (ev) => {
          if (ev.candidate && !closed) {
            postSignal(
              topicUrl,
              { type: 'ice', from: 'sender', senderId, peerId, candidate: ev.candidate },
              fetchImpl
            ).catch(() => {});
          }
        };

        dc.onopen = async () => {
          peerState.state = 'sending';
          emitPeerState();
          try {
            for (const lec of manifest.lectures) {
              for (const f of lec.files) {
                if (closed) return;
                const file = await readPartFile(lec.meta.id, f.relPath);
                await streamFileOverChannel(dc, lec.meta.id, f.relPath, file, (n) => {
                  peerState.sentBytes += n;
                  emitPeerState();
                });
              }
            }
            dc.send(JSON.stringify({ type: 'done' }));
            peerState.state = 'done';
            emitPeerState();
          } catch (err) {
            peerState.state = 'error';
            emitPeerState();
            try {
              dc.send(JSON.stringify({ type: 'error', message: err?.message || 'Transfer failed.' }));
            } catch {
              // ignore
            }
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await postSignal(topicUrl, { type: 'offer', senderId, peerId, sdp: offer }, fetchImpl);
        return;
      }

      const peer = msg.peerId ? peers.get(msg.peerId) : null;
      if (!peer) return;

      if (msg.type === 'answer' && msg.sdp) {
        await peer.pc.setRemoteDescription(msg.sdp);
        for (const cand of peer.pendingIce) {
          await peer.pc.addIceCandidate(cand);
        }
        peer.pendingIce = [];
      } else if (msg.type === 'ice' && msg.from === 'receiver' && msg.candidate) {
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(msg.candidate);
        } else {
          peer.pendingIce.push(msg.candidate);
        }
      }
    },
    EventSourceImpl
  );

  return {
    code,
    close() {
      closed = true;
      es.close();
      for (const p of peers.values()) {
        try {
          p.dc.close();
          p.pc.close();
        } catch {
          // ignore
        }
      }
      peers.clear();
    },
  };
}

/**
 * Connect to a Drop Code, fetch the sender's manifest (for size/layer preview),
 * and pull files over WebRTC DataChannel when `pull()` is called.
 */
export function createDropReceiver({
  code,
  relayUrl = 'https://ntfy.sh',
  fetchImpl = fetch,
  EventSourceImpl = EventSource,
  PeerConnectionImpl = RTCPeerConnection,
}) {
  const { clean, formatted } = normalizeDropCode(code);
  const topicUrl = buildTopicUrl(relayUrl, clean);
  const peerId = makePeerId();

  let senderId = null;
  let manifest = null;
  let pc = null;
  let closed = false;
  let es = null;
  let pendingIce = [];

  const manifestPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!manifest) reject(new Error(`No active Drop found for code ${formatted}.`));
    }, 15_000);

    es = subscribeSignals(
      topicUrl,
      async (msg) => {
        if (closed) return;
        if (msg.type === 'manifest' && msg.manifest && !manifest) {
          clearTimeout(timer);
          senderId = msg.senderId;
          manifest = msg.manifest;
          resolve({ senderId, manifest });
          return;
        }
        if (!pc || msg.senderId !== senderId || msg.peerId !== peerId) return;

        if (msg.type === 'offer' && msg.sdp) {
          await pc.setRemoteDescription(msg.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await postSignal(topicUrl, { type: 'answer', senderId, peerId, sdp: answer }, fetchImpl);
          for (const cand of pendingIce) {
            await pc.addIceCandidate(cand);
          }
          pendingIce = [];
        } else if (msg.type === 'ice' && msg.from === 'sender' && msg.candidate) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(msg.candidate);
          } else {
            pendingIce.push(msg.candidate);
          }
        }
      },
      EventSourceImpl
    );
  });

  async function pull({ onFileStart, onFileChunk, onFileEnd, onProgress } = {}) {
    if (!manifest || !senderId) {
      await manifestPromise;
    }
    pc = new PeerConnectionImpl({ iceServers: DEFAULT_ICE_SERVERS });
    pc.onicecandidate = (ev) => {
      if (ev.candidate && !closed) {
        postSignal(
          topicUrl,
          { type: 'ice', from: 'receiver', senderId, peerId, candidate: ev.candidate },
          fetchImpl
        ).catch(() => {});
      }
    };

    const totalBytes = manifest.totalBytes || 0;
    let receivedBytes = 0;
    let activeFile = null;
    let writeChain = Promise.resolve();

    const transferPromise = new Promise((resolve, reject) => {
      pc.ondatachannel = (ev) => {
        const dc = ev.channel;
        dc.binaryType = 'arraybuffer';
        dc.onmessage = (msgEv) => {
          writeChain = writeChain
            .then(async () => {
              if (typeof msgEv.data === 'string') {
                const ctrl = JSON.parse(msgEv.data);
                if (ctrl.type === 'file-start') {
                  activeFile = { lectureId: ctrl.lectureId, relPath: ctrl.relPath, size: ctrl.size };
                  await onFileStart?.(activeFile);
                  onProgress?.({ receivedBytes, totalBytes, currentFile: ctrl.relPath });
                } else if (ctrl.type === 'file-end') {
                  if (activeFile) await onFileEnd?.(activeFile);
                  activeFile = null;
                } else if (ctrl.type === 'done') {
                  resolve({ manifest });
                } else if (ctrl.type === 'error') {
                  reject(new Error(ctrl.message || 'Sender aborted transfer.'));
                }
              } else if (activeFile) {
                const chunk = new Uint8Array(msgEv.data);
                receivedBytes += chunk.byteLength;
                await onFileChunk?.(activeFile, chunk);
                onProgress?.({ receivedBytes, totalBytes, currentFile: activeFile.relPath });
              }
            })
            .catch(reject);
        };
        dc.onerror = () => reject(new Error('WebRTC DataChannel error during transfer.'));
      };
    });

    await postSignal(topicUrl, { type: 'join', senderId, peerId }, fetchImpl);
    return transferPromise;
  }

  return {
    code: formatted,
    waitForManifest: () => manifestPromise,
    pull,
    close() {
      closed = true;
      es?.close();
      try {
        pc?.close();
      } catch {
        // ignore
      }
    },
  };
}
