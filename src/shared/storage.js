import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

export function createStorage(area) {
  let writeQueue = Promise.resolve();

  function enqueueWrite(fn) {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => {});
    return next;
  }

  async function getSettings() {
    const res = await area.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
  }

  function saveSettings(patch) {
    return enqueueWrite(async () => {
      const next = { ...(await getSettings()), ...patch };
      await area.set({ [STORAGE_KEYS.SETTINGS]: next });
      return next;
    });
  }

  async function listLectures() {
    const res = await area.get(STORAGE_KEYS.LECTURES);
    const list = Array.isArray(res[STORAGE_KEYS.LECTURES]) ? res[STORAGE_KEYS.LECTURES] : [];
    return [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function getLecture(id) {
    const list = await listLectures();
    return list.find((l) => l.id === id) || null;
  }

  function upsertLecture(entry) {
    return enqueueWrite(async () => {
      const list = await listLectures();
      const idx = list.findIndex((l) => l.id === entry.id);
      const merged = idx >= 0 ? { ...list[idx], ...entry } : entry;
      if (idx >= 0) list[idx] = merged;
      else list.unshift(merged);
      await area.set({ [STORAGE_KEYS.LECTURES]: list });
      return merged;
    });
  }

  function deleteLectureMeta(id) {
    return enqueueWrite(async () => {
      const list = (await listLectures()).filter((l) => l.id !== id);
      await area.set({ [STORAGE_KEYS.LECTURES]: list });
    });
  }

  function updateLectures(ids, patchOrFn) {
    const targetIds = new Set(ids || []);
    return enqueueWrite(async () => {
      if (targetIds.size === 0) return [];
      const list = await listLectures();
      const updated = [];
      const next = list.map((lec) => {
        if (!targetIds.has(lec.id)) return lec;
        const patch = typeof patchOrFn === 'function' ? patchOrFn(lec) : patchOrFn;
        const merged = { ...lec, ...patch };
        updated.push(merged);
        return merged;
      });
      if (updated.length > 0) await area.set({ [STORAGE_KEYS.LECTURES]: next });
      return updated;
    });
  }

  async function getActiveSession() {
    const res = await area.get(STORAGE_KEYS.ACTIVE_SESSION);
    return res[STORAGE_KEYS.ACTIVE_SESSION] || null;
  }

  function setActiveSession(session) {
    return enqueueWrite(() => area.set({ [STORAGE_KEYS.ACTIVE_SESSION]: session }));
  }

  function recoverStaleRecordings(activeLectureId) {
    return enqueueWrite(async () => {
      const list = await listLectures();
      let count = 0;
      const next = list.map((lec) => {
        if (lec.status !== 'recording' || lec.id === activeLectureId) return lec;
        count += 1;
        const elapsedSec =
          lec.lastChunkAtMs && lec.startedAtMs
            ? Math.max(1, Math.round((lec.lastChunkAtMs - lec.startedAtMs) / 1000))
            : lec.durationSec || 0;
        return {
          ...lec,
          status: 'recorded',
          recoveredFromCrash: true,
          durationSec: elapsedSec,
        };
      });
      if (count > 0) await area.set({ [STORAGE_KEYS.LECTURES]: next });
      return count;
    });
  }

  return {
    getSettings,
    saveSettings,
    listLectures,
    getLecture,
    upsertLecture,
    updateLectures,
    deleteLectureMeta,
    getActiveSession,
    setActiveSession,
    recoverStaleRecordings,
  };
}

const defaultArea = {
  get: (k) => chrome.storage.local.get(k),
  set: (v) => chrome.storage.local.set(v),
};

export const {
  getSettings,
  saveSettings,
  listLectures,
  getLecture,
  upsertLecture,
  updateLectures,
  deleteLectureMeta,
  getActiveSession,
  setActiveSession,
  recoverStaleRecordings,
} = createStorage(defaultArea);
