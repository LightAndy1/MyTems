import { formatTimestamp } from '../shared/sanitize.js';
import { getLecture, getSettings, upsertLecture } from '../shared/storage.js';
import { listDirFiles, readLectureFile, readLectureJson, writeLectureJson } from '../shared/opfs.js';
import { extractSlidesFromVideo } from './slides.js';
import { blobToDataUrl, generateStructuredNotes, transcribeAudioSegment } from './ai-client.js';

const DEFAULT_DEPS = {
  getLecture,
  getSettings,
  upsertLecture,
  readLectureJson,
  writeLectureJson,
  readLectureFile,
  listDirFiles,
  transcribeAudioSegment,
  extractSlidesFromVideo,
  generateStructuredNotes,
  blobToDataUrl,
};

/**
 * Merge chunked STT results into a single timeline by adding each chunk's offsetSec.
 */
export function mergeTranscriptSegments(chunkResults) {
  const segments = [];
  let sttCostUsd = 0;
  let detectedLanguage = 'auto';

  for (const { offsetSec, result } of chunkResults) {
    if (result.language && result.language !== 'auto') detectedLanguage = result.language;
    sttCostUsd += Number(result.costUsd || 0);
    for (const seg of result.segments || []) {
      segments.push({
        startSec: Number((offsetSec + seg.startSec).toFixed(2)),
        endSec: Number((offsetSec + seg.endSec).toFixed(2)),
        text: seg.text,
      });
    }
  }
  return {
    segments,
    fullText: segments.map((s) => s.text).join(' '),
    detectedLanguage,
    sttCostUsd: Number(sttCostUsd.toFixed(6)),
  };
}

/**
 * Build OpenAI-compatible vision chat messages combining transcript and slide frames.
 */
export function buildVisionMessages(transcript, slidePayloads, courseHint = '') {
  const transcriptLines = transcript.segments
    .map((s) => `[${formatTimestamp(s.startSec)} | ${Math.floor(s.startSec)}s] ${s.text}`)
    .join('\n');

  const slideIndex = slidePayloads
    .map((s, idx) => `Slide #${idx} @ ${formatTimestamp(s.timestampSec)} (${Math.floor(s.timestampSec)}s)`)
    .join('\n');

  const system = [
    'You are an expert university lecture note-taker.',
    'Write notes automatically in the lecture primary spoken language (Romanian or English), preserving English technical terms verbatim.',
    'Return ONLY valid JSON matching: { "summary": string, "chapters": [{ "title": string, "startSec": number, "endSec": number, "bullets": string[], "formulas": string[], "slideRefs": number[] }], "definitions": [{ "term": string, "definition": string, "timestampSec": number }], "examRadar": [{ "type": "exam_hint"|"deadline"|"homework", "text": string, "timestampSec": number, "dueDate": string|null }] }.',
  ].join(' ');

  const userContent = [
    {
      type: 'text',
      text: [
        courseHint ? `Course/Context hint: ${courseHint}` : '',
        'Slide timestamps (0-based index for slideRefs):',
        slideIndex || '(no slides extracted)',
        '\nTimestamped transcript:\n',
        transcriptLines,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    ...slidePayloads.map((s) => ({ type: 'image_url', image_url: { url: s.dataUrl } })),
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

/**
 * Run the checkpointed lecture processing pipeline: STT -> slide extraction -> multimodal notes.
 */
export async function runLecturePipeline({
  lectureId,
  courseHint,
  onStage = () => {},
  deps = DEFAULT_DEPS,
}) {
  const resolvedDeps = deps === DEFAULT_DEPS ? DEFAULT_DEPS : { ...DEFAULT_DEPS, ...deps };
  const [lecture, settings] = await Promise.all([
    resolvedDeps.getLecture(lectureId),
    resolvedDeps.getSettings(),
  ]);
  if (!lecture) throw new Error(`Lecture ${lectureId} not found`);
  const activeHint = (courseHint ?? lecture.courseHint ?? settings.defaultCourseHint ?? '').trim();

  try {
    let transcript = await resolvedDeps.readLectureJson(lectureId, 'transcript.json');
    if (!transcript) {
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'transcribing', courseHint: activeHint, error: '' });
      onStage('Transcribing audio...');

      const segmentsMeta = lecture.audioSegments?.length
        ? lecture.audioSegments
        : (await resolvedDeps.listDirFiles(lectureId, 'audio')).map((f, i) => ({
            filename: `audio/${f}`,
            offsetSec: i * 600,
          }));

      const chunkResults = [];
      for (let i = 0; i < segmentsMeta.length; i++) {
        onStage(`Transcribing part ${i + 1}/${segmentsMeta.length}...`);
        const seg = segmentsMeta[i];
        const blob = await resolvedDeps.readLectureFile(lectureId, seg.filename);
        const result = await resolvedDeps.transcribeAudioSegment({
          settings,
          blob,
          filename: seg.filename.split('/').pop(),
        });
        chunkResults.push({ offsetSec: seg.offsetSec, result });
      }
      transcript = mergeTranscriptSegments(chunkResults);
      await resolvedDeps.writeLectureJson(lectureId, 'transcript.json', transcript);
    }

    onStage('Extracting slides...');
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'extracting_slides' });
    if (!lecture.slidesExtracted) {
      try {
        const videoFile = await resolvedDeps.readLectureFile(lectureId, 'video.webm');
        await resolvedDeps.extractSlidesFromVideo(videoFile, lectureId, (p) =>
          onStage(`Extracting slides (${Math.round(p * 100)}%)...`)
        );
        await resolvedDeps.upsertLecture({ id: lectureId, slidesExtracted: true });
      } catch (err) {
        if (err?.name !== 'NotFoundError' && !String(err?.message).includes('NotFoundError')) throw err;
      }
    }
    const slides = (await resolvedDeps.listDirFiles(lectureId, 'slides')).map((filename) => ({
      filename,
      timestampSec: Number(filename.split('_')[1]?.split('.')[0] || 0),
    }));

    onStage('Generating study notes & Exam Radar...');
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'summarizing' });
    const slidePayloads = [];
    for (const s of slides) {
      const file = await resolvedDeps.readLectureFile(lectureId, `slides/${s.filename}`);
      const mime = s.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      slidePayloads.push({ ...s, dataUrl: await resolvedDeps.blobToDataUrl(file, mime) });
    }

    const messages = buildVisionMessages(transcript, slidePayloads, activeHint);
    const { notes: rawNotes, costUsd } = await resolvedDeps.generateStructuredNotes({ settings, messages });
    const notes = {
      ...rawNotes,
      slides,
      sttCostUsd: transcript.sttCostUsd || 0,
      llmCostUsd: Number(costUsd.toFixed(6)),
      totalCostUsd: Number(((transcript.sttCostUsd || 0) + costUsd).toFixed(6)),
      generatedAt: new Date().toISOString(),
    };
    await resolvedDeps.writeLectureJson(lectureId, 'notes.json', notes);
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'ready', courseHint: activeHint, error: '' });
    return { transcript, notes, slides };
  } catch (err) {
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'error', error: err?.message || String(err) });
    throw err;
  }
}
