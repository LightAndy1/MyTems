import { notesToNotionMarkdown } from './notion.js';
import { buildDownloadFilename, formatTimestamp } from './sanitize.js';
import { buildStoreZip } from './zip.js';

async function readOptionalFile(readLectureFileFn, lectureId, relPath) {
  try {
    return await readLectureFileFn(lectureId, relPath);
  } catch (err) {
    if (err?.name === 'NotFoundError' || /not\s*found/i.test(err?.message || '')) return null;
    throw err;
  }
}

async function fileToBytes(file) {
  if (file instanceof Uint8Array) return file;
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Format transcript segments into plain timestamped text for ZIP export when notes are absent.
 */
export function formatTranscriptText(transcript) {
  const segments = transcript?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments
    .map((seg) => {
      const ts = formatTimestamp(seg.startSec);
      const speaker = String(seg.speaker || '').trim();
      return speaker ? `[${ts}] ${speaker}: ${seg.text}` : `[${ts}] ${seg.text}`;
    })
    .join('\n') + '\n';
}

/**
 * Check whether any lecture part has audio segments without a recorded video.webm.
 */
export async function hasAudioOnlyMedia(parts, { readLectureFile, listDirFiles }) {
  for (const part of parts || []) {
    if (!part?.id) continue;
    const videoFile = await readOptionalFile(readLectureFile, part.id, 'video.webm');
    if (videoFile) continue;
    const audioFiles = await listDirFiles(part.id, 'audio');
    if (audioFiles.length > 0) return true;
  }
  return false;
}

/**
 * Resolve direct media download for a lecture: video.webm if recorded, else audio segment(s).
 */
export async function resolveLectureMediaDownload(
  lectureId,
  lecture,
  partMeta = { partIndex: 1, totalParts: 1 },
  { readLectureFile, listDirFiles }
) {
  if (!lecture) return null;
  const videoFile = await readOptionalFile(readLectureFile, lectureId, 'video.webm');
  if (videoFile) {
    return {
      blob: videoFile,
      filename: buildDownloadFilename(lecture, { ...partMeta, kind: 'video' }),
      kind: 'video',
    };
  }

  const audioFiles = await listDirFiles(lectureId, 'audio');
  if (audioFiles.length === 0) return null;

  if (audioFiles.length === 1) {
    const audioFile = await readLectureFile(lectureId, `audio/${audioFiles[0]}`);
    return {
      blob: audioFile,
      filename: buildDownloadFilename(lecture, { ...partMeta, kind: 'audio' }),
      kind: 'audio',
    };
  }

  const entries = [];
  for (const f of audioFiles) {
    const file = await readLectureFile(lectureId, `audio/${f}`);
    entries.push({ name: f, data: await fileToBytes(file) });
  }
  return {
    blob: new Blob([buildStoreZip(entries)], { type: 'application/zip' }),
    filename: buildDownloadFilename(lecture, { ...partMeta, kind: 'audio-zip' }),
    kind: 'audio-zip',
  };
}

/**
 * Build a ZIP archive payload containing notes (if generated), slides, transcript fallback,
 * and audio segments for parts that have no recorded video.webm.
 */
export async function buildExportZipPayload({
  parts,
  isMultiPart = false,
  lessonTitle = '',
  lessonSubject = '',
  courseHint = '',
  notes = null,
  partMeta = { partIndex: 1, totalParts: 1 },
  deps,
}) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const enc = new TextEncoder();
  const zipEntries = [];
  const slideEntriesMeta = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const prefix = isMultiPart ? `pt${i + 1}_` : '';

    const slideFiles = await deps.listDirFiles(part.id, 'slides');
    for (const f of slideFiles) {
      const zipPath = `slides/${prefix}${f}`;
      slideEntriesMeta.push(isMultiPart ? { partIndex: i + 1, filename: f, zipPath } : f);
      const file = await deps.readLectureFile(part.id, `slides/${f}`);
      zipEntries.push({ name: zipPath, data: await fileToBytes(file) });
    }

    // Audio segments are included only when no video was recorded for this part.
    const hasVideo = Boolean(await readOptionalFile(deps.readLectureFile, part.id, 'video.webm'));
    if (!hasVideo) {
      const audioFiles = await deps.listDirFiles(part.id, 'audio');
      for (const f of audioFiles) {
        const file = await deps.readLectureFile(part.id, `audio/${f}`);
        zipEntries.push({ name: `audio/${prefix}${f}`, data: await fileToBytes(file) });
      }
    }

    if (!notes) {
      const transcript = await deps.readLectureJson(part.id, 'transcript.json');
      const text = formatTranscriptText(transcript);
      if (text) {
        const transcriptPath = isMultiPart ? `transcripts/pt${i + 1}.txt` : 'transcript.txt';
        zipEntries.push({ name: transcriptPath, data: enc.encode(text) });
      }
    }
  }

  if (notes) {
    const meta = isMultiPart
      ? {
          title: lessonTitle,
          subject: lessonSubject,
          createdAt: parts[0].createdAt,
          courseHint,
        }
      : parts[0];
    const md = notesToNotionMarkdown(meta, notes, slideEntriesMeta);
    zipEntries.unshift({ name: 'notes.md', data: enc.encode(md) });
  }

  if (zipEntries.length === 0) return null;

  const filename = isMultiPart
    ? buildDownloadFilename(parts[0], {
        kind: notes ? 'lesson-zip' : 'lesson-export-zip',
        lessonTitle,
      })
    : buildDownloadFilename(parts[0], {
        partIndex: partMeta.partIndex,
        totalParts: partMeta.totalParts,
        kind: notes ? 'notion-zip' : 'export-zip',
      });

  return {
    zipBytes: buildStoreZip(zipEntries),
    filename,
    entryNames: zipEntries.map((e) => e.name),
  };
}
