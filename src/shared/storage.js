import { AI_VENDOR_IDS, DEFAULT_SETTINGS, DEFAULT_VENDOR_KEYS, STORAGE_KEYS } from './constants.js';

function pickVendor(value, fallback) {
  return AI_VENDOR_IDS.includes(value) ? value : fallback;
}

/**
 * Normalize legacy and per-task AI settings into one consistent shape.
 */
export function normalizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const rawKeys = raw?.vendorKeys && typeof raw.vendorKeys === 'object' ? raw.vendorKeys : {};
  const openrouterKey = String(rawKeys.openrouter ?? merged.openrouterApiKey ?? '').trim();
  const vendorKeys = {
    ...DEFAULT_VENDOR_KEYS,
    ...rawKeys,
    openrouter: openrouterKey,
  };
  for (const id of AI_VENDOR_IDS) {
    vendorKeys[id] = String(vendorKeys[id] || '').trim();
  }

  const legacyLocal = !raw?.sttVendor && !raw?.llmVendor && raw?.providerMode === 'local';
  const sttVendor = pickVendor(raw?.sttVendor, legacyLocal ? 'custom' : 'openrouter');
  const llmVendor = pickVendor(raw?.llmVendor, legacyLocal ? 'custom' : 'openrouter');
  const jevVendor = pickVendor(raw?.jevVendor, 'openrouter');

  const sttModel =
    raw?.sttModel !== undefined
      ? String(raw.sttModel)
      : sttVendor === 'custom'
        ? String(merged.localSttModel || DEFAULT_SETTINGS.localSttModel)
        : DEFAULT_SETTINGS.sttModel;
  const llmModel =
    raw?.llmModel !== undefined
      ? String(raw.llmModel)
      : llmVendor === 'custom'
        ? String(merged.localLlmModel || DEFAULT_SETTINGS.localLlmModel)
        : DEFAULT_SETTINGS.llmModel;

  return {
    ...merged,
    openrouterApiKey: openrouterKey,
    vendorKeys,
    sttVendor,
    sttModel,
    llmVendor,
    llmModel,
    jevVendor,
  };
}

export function createStorage(area) {
  let writeQueue = Promise.resolve();

  function enqueueWrite(fn) {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => {});
    return next;
  }

  async function getSettings() {
    const res = await area.get(STORAGE_KEYS.SETTINGS);
    return normalizeSettings(res[STORAGE_KEYS.SETTINGS]);
  }

  function saveSettings(patch) {
    return enqueueWrite(async () => {
      const current = await getSettings();
      const nextRaw = { ...current, ...(patch || {}) };
      if (patch?.vendorKeys) {
        nextRaw.vendorKeys = { ...current.vendorKeys, ...patch.vendorKeys };
        if (patch.vendorKeys.openrouter !== undefined) {
          nextRaw.openrouterApiKey = patch.vendorKeys.openrouter;
        }
      } else if (patch?.openrouterApiKey !== undefined) {
        nextRaw.vendorKeys = { ...current.vendorKeys, openrouter: patch.openrouterApiKey };
      }
      if (patch?.sttVendor === 'custom' && patch?.localSttModel && !patch?.sttModel) {
        nextRaw.sttModel = patch.localSttModel;
      }
      if (patch?.llmVendor === 'custom' && patch?.localLlmModel && !patch?.llmModel) {
        nextRaw.llmModel = patch.localLlmModel;
      }
      const next = normalizeSettings(nextRaw);
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
