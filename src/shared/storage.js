import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

export function createStorage(area) {
  async function getSettings() {
    const res = await area.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
  }

  async function saveSettings(patch) {
    const next = { ...(await getSettings()), ...patch };
    await area.set({ [STORAGE_KEYS.SETTINGS]: next });
    return next;
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

  async function upsertLecture(entry) {
    const list = await listLectures();
    const idx = list.findIndex((l) => l.id === entry.id);
    const merged = idx >= 0 ? { ...list[idx], ...entry } : entry;
    if (idx >= 0) list[idx] = merged;
    else list.unshift(merged);
    await area.set({ [STORAGE_KEYS.LECTURES]: list });
    return merged;
  }

  async function deleteLectureMeta(id) {
    const list = (await listLectures()).filter((l) => l.id !== id);
    await area.set({ [STORAGE_KEYS.LECTURES]: list });
  }

  async function getActiveSession() {
    const res = await area.get(STORAGE_KEYS.ACTIVE_SESSION);
    return res[STORAGE_KEYS.ACTIVE_SESSION] || null;
  }

  async function setActiveSession(session) {
    await area.set({ [STORAGE_KEYS.ACTIVE_SESSION]: session });
  }

  async function recoverStaleRecordings(activeLectureId) {
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
  }

  return {
    getSettings,
    saveSettings,
    listLectures,
    getLecture,
    upsertLecture,
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
  deleteLectureMeta,
  getActiveSession,
  setActiveSession,
  recoverStaleRecordings,
} = createStorage(defaultArea);
