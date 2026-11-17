import { formatLocalDateTimeParts, toSafeFilename } from './sanitize.js';

export const STANDALONE_PREFIX = 'standalone:';

export function normalizeGroupKey(value) {
  return toSafeFilename(String(value || '').trim().toLowerCase()).toLowerCase();
}

export function resolveLectureSubject(lecture) {
  const s = String(lecture?.subject || lecture?.courseHint || lecture?.title || '').trim();
  return s || 'Teams Lecture';
}

export function resolveLectureDate(lecture) {
  return formatLocalDateTimeParts(lecture?.startedAtMs || lecture?.createdAt).date;
}

function lectureStartMs(lecture) {
  if (Number.isFinite(lecture?.startedAtMs)) return lecture.startedAtMs;
  const parsed = Date.parse(lecture?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRawLessonKey(lecture, subject) {
  if (lecture?.lessonId) return String(lecture.lessonId);
  return `auto:${resolveLectureDate(lecture)}:${normalizeGroupKey(subject)}`;
}

export function buildLibraryTree(lectures = []) {
  const subjectBuckets = new Map();

  for (const lec of lectures) {
    const subject = resolveLectureSubject(lec);
    const subjKey = normalizeGroupKey(subject);
    if (!subjectBuckets.has(subjKey)) {
      subjectBuckets.set(subjKey, { name: subject, lessonsMap: new Map(), latestMs: 0 });
    }
    const subjBucket = subjectBuckets.get(subjKey);
    const ms = lectureStartMs(lec);
    if (ms > subjBucket.latestMs) {
      subjBucket.latestMs = ms;
      subjBucket.name = subject;
    }

    const lessonId = resolveRawLessonKey(lec, subject);
    if (!subjBucket.lessonsMap.has(lessonId)) {
      subjBucket.lessonsMap.set(lessonId, []);
    }
    subjBucket.lessonsMap.get(lessonId).push(lec);
  }

  const lessonsById = new Map();
  const partMetaById = new Map();

  const subjects = [...subjectBuckets.values()]
    .sort((a, b) => b.latestMs - a.latestMs)
    .map((subj) => {
      const lessons = [...subj.lessonsMap.entries()]
        .map(([lessonId, rawParts]) => {
          const parts = [...rawParts].sort((a, b) => lectureStartMs(a) - lectureStartMs(b));
          const latestMs = parts.reduce((max, p) => Math.max(max, lectureStartMs(p)), 0);
          const first = parts[0];
          const date = resolveLectureDate(first);
          const customTitle = parts.find((p) => p.lessonTitle?.trim())?.lessonTitle?.trim();
          const isGroup = parts.length > 1 || (!lessonId.startsWith('auto:') && !lessonId.startsWith(STANDALONE_PREFIX));
          const defaultTitle = isGroup ? `${date} · ${first.title || subj.name}` : (first.title || subj.name);
          const title = customTitle || defaultTitle;
          const totalDurationSec = parts.reduce((sum, p) => sum + Number(p.durationSec || 0), 0);

          const node = {
            lessonId,
            subject: subj.name,
            date,
            title,
            parts,
            isGroup,
            latestMs,
            totalDurationSec,
          };
          lessonsById.set(lessonId, node);
          parts.forEach((p, idx) => {
            partMetaById.set(p.id, {
              lessonId,
              subject: subj.name,
              partIndex: idx + 1,
              totalParts: parts.length,
              isGroup: parts.length > 1,
            });
          });
          return node;
        })
        .sort((a, b) => b.latestMs - a.latestMs);

      return { name: subj.name, latestMs: subj.latestMs, lessons };
    });

  return { subjects, lessonsById, partMetaById };
}

export function findPreviousSubjectLesson(tree, subject, currentLessonId) {
  const current = tree.lessonsById.get(currentLessonId);
  const subjNode = tree.subjects.find((s) => normalizeGroupKey(s.name) === normalizeGroupKey(subject));
  if (!subjNode || !current) return null;
  const currentStart = lectureStartMs(current.parts[0]);
  const earlier = subjNode.lessons
    .filter((l) => l.lessonId !== currentLessonId && lectureStartMs(l.parts[0]) < currentStart)
    .sort((a, b) => lectureStartMs(b.parts[0]) - lectureStartMs(a.parts[0]));
  return earlier[0] || null;
}
