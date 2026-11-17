const handles = new Map();
const inFlightHandles = new Map();
let opQueue = Promise.resolve();

async function getHandle(lectureId, relPath) {
  const key = `${lectureId}/${relPath}`;
  if (handles.has(key)) return handles.get(key);
  if (inFlightHandles.has(key)) return inFlightHandles.get(key);

  const opening = (async () => {
    const root = await navigator.storage.getDirectory();
    const lectures = await root.getDirectoryHandle('lectures', { create: true });
    let dir = await lectures.getDirectoryHandle(lectureId, { create: true });
    const parts = relPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create: true });
    const fh = await dir.getFileHandle(fileName, { create: true });
    const access = await fh.createSyncAccessHandle();
    const state = { access, offset: access.getSize() };
    handles.set(key, state);
    return state;
  })();

  inFlightHandles.set(key, opening);
  try {
    return await opening;
  } finally {
    inFlightHandles.delete(key);
  }
}

async function handleMessage({ id, type, lectureId, relPath, bytes }) {
  try {
    if (type === 'append') {
      const state = await getHandle(lectureId, relPath);
      const buf = new Uint8Array(bytes);
      state.access.write(buf, { at: state.offset });
      state.offset += buf.byteLength;
      state.access.flush();
    } else if (type === 'close') {
      const key = `${lectureId}/${relPath}`;
      const state = handles.get(key);
      if (state) {
        state.access.flush();
        state.access.close();
        handles.delete(key);
      }
    } else if (type === 'closeAll') {
      for (const [key, state] of handles.entries()) {
        state.access.flush();
        state.access.close();
        handles.delete(key);
      }
    }
    self.postMessage({ id, ok: true });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
}

self.onmessage = (event) => {
  opQueue = opQueue.then(() => handleMessage(event.data));
};
