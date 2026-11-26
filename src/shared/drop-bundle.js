import { DROP_LAYERS } from './constants.js';
import { STANDALONE_PREFIX } from './grouping.js';
import { createLectureId, toSafeFilename } from './sanitize.js';
import { buildStoreZipBlob, readZipEntries } from './zip.js';

export const DROP_SCHEMA_VERSION = 1;
export const DROP_MANIFEST_FILENAME = 'mytems-bundle.json';

async function readOptionalFile(readLectureFileFn, lectureId, relPath) {
  try {
    return await readLectureFileFn(lectureId, relPath);
  } catch (err) {
    if (err?.name === 'NotFoundError' || /not\s*found/i.test(err?.message || '')) return null;
    throw err;
  }
}

function getFileSize(file) {
  if (!file) return 0;
  if (typeof file.size === 'number') return file.size;
  if (typeof file.byteLength === 'number') return file.byteLength;
  return 0;
}

/**
 * Inspect OPFS files for each lecture part and compute available layers + exact byte sizes.
 */
export async function inspectPartsForDrop(parts, { readLectureFile, listDirFiles }) {
  const inspected = [];
  for (const part of parts || []) {
    if (!part?.id) continue;
    const layers = {
      video: { files: [], bytes: 0 },
      audio: { files: [], bytes: 0 },
      slides: { files: [], bytes: 0 },
      transcript: { files: [], bytes: 0 },
      notes: { files: [], bytes: 0 },
    };

    const videoFile = await readOptionalFile(readLectureFile, part.id, 'video.webm');
    if (videoFile) {
      const size = getFileSize(videoFile);
      layers.video.files.push({ relPath: 'video.webm', size });
      layers.video.bytes += size;
    }

    const audioNames = await listDirFiles(part.id, 'audio');
    for (const name of audioNames) {
      const relPath = `audio/${name}`;
      const f = await readOptionalFile(readLectureFile, part.id, relPath);
      if (!f) continue;
      const size = getFileSize(f);
      layers.audio.files.push({ relPath, size });
      layers.audio.bytes += size;
    }

    const slideNames = await listDirFiles(part.id, 'slides');
    for (const name of slideNames) {
      const relPath = `slides/${name}`;
      const f = await readOptionalFile(readLectureFile, part.id, relPath);
      if (!f) continue;
      const size = getFileSize(f);
      layers.slides.files.push({ relPath, size });
      layers.slides.bytes += size;
    }
    const slidesJson = await readOptionalFile(readLectureFile, part.id, 'slides.json');
    if (slidesJson) {
      const size = getFileSize(slidesJson);
      layers.slides.files.push({ relPath: 'slides.json', size });
      layers.slides.bytes += size;
    }

    const transcriptFile = await readOptionalFile(readLectureFile, part.id, 'transcript.json');
    if (transcriptFile) {
      const size = getFileSize(transcriptFile);
      layers.transcript.files.push({ relPath: 'transcript.json', size });
      layers.transcript.bytes += size;
    }

    const notesFile = await readOptionalFile(readLectureFile, part.id, 'notes.json');
    if (notesFile) {
      const size = getFileSize(notesFile);
      layers.notes.files.push({ relPath: 'notes.json', size });
      layers.notes.bytes += size;
    }

    inspected.push({ part, layers });
  }
  return inspected;
}

/**
 * Build a portable drop manifest from inspected parts, selected part IDs, and selected layers.
 */
export function buildDropManifest(inspectedParts, selectedPartIds, selectedLayers) {
  const partSet = new Set(selectedPartIds || []);
  const layerOrder = DROP_LAYERS.map((l) => l.id).filter((id) => selectedLayers?.includes(id));
  const lectures = [];
  let totalBytes = 0;

  for (const item of inspectedParts || []) {
    if (!partSet.has(item.part.id)) continue;
    const files = [];
    for (const layerId of layerOrder) {
      for (const f of item.layers[layerId]?.files || []) {
        files.push({ relPath: f.relPath, layer: layerId, size: f.size });
        totalBytes += f.size;
      }
    }
    if (files.length === 0) continue;
    lectures.push({
      meta: { ...item.part },
      files,
    });
  }

  return {
    schemaVersion: DROP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    includedLayers: layerOrder,
    totalBytes,
    lectures,
  };
}

/**
 * Build a `.mytems` archive Blob containing `mytems-bundle.json` and selected OPFS files.
 */
export async function exportDropBundleBlob(inspectedParts, selectedPartIds, selectedLayers, { readLectureFile }) {
  const manifest = buildDropManifest(inspectedParts, selectedPartIds, selectedLayers);
  if (manifest.lectures.length === 0) return null;

  const enc = new TextEncoder();
  const entries = [
    {
      name: DROP_MANIFEST_FILENAME,
      data: enc.encode(JSON.stringify(manifest, null, 2)),
    },
  ];

  for (const lec of manifest.lectures) {
    const id = lec.meta.id;
    for (const f of lec.files) {
      const file = await readLectureFile(id, f.relPath);
      entries.push({
        name: `parts/${id}/${f.relPath}`,
        data: file,
      });
    }
  }

  const blob = await buildStoreZipBlob(entries);
  const first = manifest.lectures[0]?.meta;
  const baseName = toSafeFilename(first?.lessonTitle || first?.title || 'mytems-drop');
  const suffix = manifest.lectures.length > 1 ? `-${manifest.lectures.length}drops` : '';
  return {
    blob,
    manifest,
    filename: `${baseName}${suffix}.mytems`,
  };
}

/**
 * Parse a `.mytems` or `.zip` Blob/Uint8Array into manifest + entry lookup map.
 */
export async function parseDropBundle(blobOrBytes) {
  const entries = await readZipEntries(blobOrBytes);
  const entryByName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = entryByName.get(DROP_MANIFEST_FILENAME);
  if (!manifestEntry) {
    throw new Error(`Not a valid .mytems drop: missing ${DROP_MANIFEST_FILENAME}.`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(await manifestEntry.readBytes()));
  if (manifest?.schemaVersion !== DROP_SCHEMA_VERSION || !Array.isArray(manifest.lectures)) {
    throw new Error('Unsupported .mytems bundle schema version.');
  }
  return { manifest, entryByName };
}

function isValidRelPath(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  if (relPath.startsWith('/') || relPath.includes('\\')) return false;
  return !relPath.split('/').some((seg) => !seg || seg === '.' || seg === '..');
}

/**
 * Plan duplicate handling (`skip` | `overwrite` | `copy` or per-id map) for incoming lectures.
 * Preserves multi-part lesson grouping when creating copies.
 */
export function planDuplicateResolution(incomingLectures, existingLectures, strategyOrMap = 'copy') {
  const existingIds = new Set((existingLectures || []).map((l) => l.id));
  const lessonIdMap = new Map();
  const usedIds = new Set(existingIds);
  const plan = [];

  for (const item of incomingLectures || []) {
    const srcMeta = item?.meta;
    if (!srcMeta?.id) continue;
    const isDup = existingIds.has(srcMeta.id);
    const action = isDup
      ? (typeof strategyOrMap === 'string' ? strategyOrMap : strategyOrMap?.[srcMeta.id] || 'skip')
      : 'import';

    if (action === 'skip') {
      plan.push({ sourceId: srcMeta.id, action: 'skip', targetMeta: null, files: item.files || [] });
      continue;
    }

    let targetId = srcMeta.id;
    let targetLessonId = srcMeta.lessonId || '';
    if (action === 'copy') {
      do {
        targetId = createLectureId();
      } while (usedIds.has(targetId));
      usedIds.add(targetId);

      if (targetLessonId) {
        if (targetLessonId.startsWith(STANDALONE_PREFIX)) {
          targetLessonId = `${STANDALONE_PREFIX}${targetId}`;
        } else {
          if (!lessonIdMap.has(targetLessonId)) {
            lessonIdMap.set(targetLessonId, `lesson_${targetId}`);
          }
          targetLessonId = lessonIdMap.get(targetLessonId);
        }
      }
    }

    const filePaths = new Set((item.files || []).map((f) => f.relPath));
    const status = filePaths.has('notes.json')
      ? 'ready'
      : filePaths.has('transcript.json')
        ? 'transcribed'
        : 'recorded';

    plan.push({
      sourceId: srcMeta.id,
      action,
      targetMeta: {
        ...srcMeta,
        id: targetId,
        lessonId: targetLessonId,
        status,
      },
      files: (item.files || []).filter((f) => isValidRelPath(f.relPath)),
    });
  }

  return plan;
}

/**
 * Import a drop bundle into OPFS + lecture metadata store using the resolved duplicate plan.
 */
export async function importDropFromEntries(
  manifest,
  entryByName,
  existingLectures,
  strategyOrMap,
  { writeLectureFile, upsertLecture, onProgress }
) {
  const plan = planDuplicateResolution(manifest.lectures, existingLectures, strategyOrMap);
  const imported = [];
  const skipped = [];

  const totalFiles = plan.reduce((sum, p) => sum + (p.action === 'skip' ? 0 : p.files.length), 0);
  let doneFiles = 0;

  for (const item of plan) {
    if (item.action === 'skip' || !item.targetMeta) {
      skipped.push(item.sourceId);
      continue;
    }
    for (const f of item.files) {
      const entry = entryByName.get(`parts/${item.sourceId}/${f.relPath}`);
      if (!entry) continue;
      const data = entry.readBlob ? await entry.readBlob() : await entry.readBytes();
      await writeLectureFile(item.targetMeta.id, f.relPath, data);
      doneFiles += 1;
      onProgress?.({ doneFiles, totalFiles, currentFile: f.relPath });
    }
    await upsertLecture(item.targetMeta);
    imported.push(item.targetMeta);
  }

  return { imported, skipped };
}
