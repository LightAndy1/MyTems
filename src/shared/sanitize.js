const RO_MAP = {
  ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't',
  Ă: 'A', Â: 'A', Î: 'I', Ș: 'S', Ş: 'S', Ț: 'T', Ţ: 'T',
};

export function deriveLectureTitle(tabTitle) {
  const cleaned = String(tabTitle || '')
    .replace(/\s*\|\s*Microsoft Teams\s*$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim();
  return cleaned || 'Teams Lecture';
}

export function toSafeFilename(title) {
  const transliterated = String(title || '').replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (ch) => RO_MAP[ch] || ch);
  const safe = transliterated
    .replace(/[^a-zA-Z0-9+._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return safe || 'Teams_Lecture';
}

export function formatLocalDateTimeParts(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
  const valid = Number.isFinite(d.getTime()) ? d : new Date(0);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())}`;
  const hh = pad(valid.getHours());
  const mm = pad(valid.getMinutes());
  return { date, time: `${hh}-${mm}`, displayTime: `${hh}:${mm}` };
}

export function buildDownloadFilename(
  lecture,
  { partIndex = 1, totalParts = 1, kind = 'video', lessonTitle = '' } = {}
) {
  const lec = lecture || {};
  const { date, time } = formatLocalDateTimeParts(lec.startedAtMs || lec.createdAt);
  if (kind === 'lesson-zip') {
    const safeLesson = toSafeFilename(lessonTitle || lec.lessonTitle || lec.subject || lec.title);
    return `${date}_${safeLesson}_lesson_notion.zip`;
  }
  const safeTitle = toSafeFilename(lec.title);
  const partSuffix = totalParts > 1 ? `_pt${partIndex}` : '';
  const ext = kind === 'notion-zip' ? '_notion.zip' : '.webm';
  return `${date}_${time}_${safeTitle}${partSuffix}${ext}`;
}

export function buildTranscriptTailPrompt(text, maxChars = 220) {
  const deduped = String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)([^\s.!?]+(?:\s+[^\s.!?]+){0,2})(?:\s+\2)+(?=\s|[.,!?;:]|$)/giu, '$1$2');
  if (!deduped) return '';
  const sentences = deduped.split(/(?<=[.!?])\s+/).filter(Boolean);
  let clean = deduped;
  if (sentences.length > 1) {
    const lastTwo = sentences.slice(-2).join(' ');
    clean = lastTwo.length <= maxChars ? lastTwo : sentences[sentences.length - 1];
  }
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(-maxChars);
  if (clean[clean.length - maxChars - 1] === ' ') return slice;
  const spaceIdx = slice.indexOf(' ');
  return spaceIdx > 0 && spaceIdx < slice.length - 1 ? slice.slice(spaceIdx + 1) : slice;
}

export function formatTimestamp(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

export function createLectureId(now = new Date()) {
  const iso = now.toISOString();
  const datePart = iso.slice(0, 10).replace(/-/g, '');
  const timePart = iso.slice(11, 19).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${datePart}-${timePart}-${rand}`;
}
