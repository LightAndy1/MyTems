import { buildTranscriptTailPrompt, formatTimestamp } from '../shared/sanitize.js';
import { getLecture, getSettings, upsertLecture } from '../shared/storage.js';
import {
  listDirFiles,
  readLectureFile,
  readLectureJson,
  readLessonJson,
  writeLectureJson,
  writeLessonJson,
} from '../shared/opfs.js';
import { extractSlidesFromVideo } from './slides.js';
import { blobToDataUrl, generateStructuredNotes, transcribeAudioSegment } from './ai-client.js';

const DEFAULT_DEPS = {
  getLecture,
  getSettings,
  upsertLecture,
  readLectureJson,
  writeLectureJson,
  readLessonJson,
  writeLessonJson,
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

async function ensureTranscript({
  lectureId,
  lecture,
  settings,
  activeHint,
  seedPrompt = '',
  force = false,
  onStage,
  resolvedDeps,
}) {
  let transcript = force ? null : await resolvedDeps.readLectureJson(lectureId, 'transcript.json');
  if (transcript) return { transcript, ranStt: false };

  await resolvedDeps.upsertLecture({ id: lectureId, status: 'transcribing', courseHint: activeHint, error: '' });
  onStage('Transcribing audio...');

  const segmentsMeta = lecture.audioSegments?.length
    ? lecture.audioSegments
    : (await resolvedDeps.listDirFiles(lectureId, 'audio')).map((f, i) => ({
        filename: `audio/${f}`,
        offsetSec: i * 600,
      }));
  if (segmentsMeta.length === 0) {
    throw new Error('No audio segments found for transcription.');
  }

  const chunkResults = [];
  const chunkTexts = [];
  for (let i = 0; i < segmentsMeta.length; i++) {
    onStage(`Transcribing part ${i + 1}/${segmentsMeta.length}...`);
    const seg = segmentsMeta[i];
    const blob = await resolvedDeps.readLectureFile(lectureId, seg.filename);
    const prompt = buildTranscriptTailPrompt([seedPrompt, ...chunkTexts].filter(Boolean).join(' '));
    const result = await resolvedDeps.transcribeAudioSegment({
      settings,
      blob,
      filename: seg.filename.split('/').pop(),
      prompt,
    });
    chunkResults.push({ offsetSec: seg.offsetSec, result });
    if (result?.text) chunkTexts.push(result.text);
  }
  transcript = mergeTranscriptSegments(chunkResults);
  await resolvedDeps.writeLectureJson(lectureId, 'transcript.json', transcript);
  return { transcript, ranStt: true };
}

async function ensureSlidesForLecture({ lectureId, lecture, onStage, resolvedDeps }) {
  const existingSlideFiles = await resolvedDeps.listDirFiles(lectureId, 'slides');
  const skipVideoSlides =
    lecture.slidesExtracted ||
    (lecture.hasWhiteboardCaptures && existingSlideFiles.some((f) => f.includes('_wb.')));

  if (!skipVideoSlides) {
    try {
      const videoFile = await resolvedDeps.readLectureFile(lectureId, 'video.webm');
      await resolvedDeps.extractSlidesFromVideo(
        videoFile,
        lectureId,
        (p) => onStage(`Extracting slides (${Math.round(p * 100)}%)...`),
        lecture.durationSec
      );
      await resolvedDeps.upsertLecture({ id: lectureId, slidesExtracted: true });
    } catch (err) {
      if (err?.name !== 'NotFoundError' && !String(err?.message).includes('NotFoundError')) throw err;
    }
  }
  return (await resolvedDeps.listDirFiles(lectureId, 'slides')).map((filename) => ({
    filename,
    timestampSec: Number(filename.split('_')[1]?.split('.')[0] || 0),
  }));
}

/**
 * Run transcription only (Stage 1 STT, $0 LLM) and save transcript.json.
 */
export async function runTranscriptionOnly({
  lectureId,
  courseHint,
  force = false,
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
    const { transcript } = await ensureTranscript({
      lectureId,
      lecture,
      settings,
      activeHint,
      force,
      onStage,
      resolvedDeps,
    });
    const existingNotes = await resolvedDeps.readLectureJson(lectureId, 'notes.json');
    await resolvedDeps.upsertLecture({
      id: lectureId,
      status: existingNotes ? 'ready' : 'transcribed',
      courseHint: activeHint,
      error: '',
    });
    return { transcript };
  } catch (err) {
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'error', error: err?.message || String(err) });
    throw err;
  }
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
    const { transcript } = await ensureTranscript({
      lectureId,
      lecture,
      settings,
      activeHint,
      force: false,
      onStage,
      resolvedDeps,
    });

    onStage('Extracting slides...');
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'extracting_slides' });
    const slides = await ensureSlidesForLecture({ lectureId, lecture, onStage, resolvedDeps });

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

/**
 * Build multimodal vision chat messages for a multi-part Lesson.
 */
export function buildLessonVisionMessages(
  partsPayload,
  { courseHint = '', subject = '', previousLessonSummary = '' } = {}
) {
  const transcriptSections = partsPayload.map(({ partIndex, lecture, transcript }) => {
    const header = `--- Part ${partIndex} (${lecture?.title || `Part ${partIndex}`}) ---`;
    const lines = (transcript?.segments || [])
      .map((s) => `[Pt ${partIndex} · ${formatTimestamp(s.startSec)} | partIndex=${partIndex} | ${Math.floor(s.startSec)}s] ${s.text}`)
      .join('\n');
    return `${header}\n${lines}`;
  });

  const allSlides = partsPayload.flatMap((p) => p.slides || []);
  const slideIndex = allSlides
    .map((s, idx) => `Slide #${idx} @ Pt ${s.partIndex} ${formatTimestamp(s.timestampSec)} (${Math.floor(s.timestampSec)}s)`)
    .join('\n');

  const system = [
    'You are an expert university lecture note-taker synthesizing a multi-part lecture from the same class.',
    'Connect topics across parts coherently without repeating the intro.',
    'Write notes automatically in the lecture primary spoken language (Romanian or English), preserving English technical terms verbatim.',
    'Return ONLY valid JSON matching: { "summary": string, "chapters": [{ "title": string, "partIndex": number, "startSec": number, "endSec": number, "bullets": string[], "formulas": string[], "slideRefs": number[] }], "definitions": [{ "term": string, "definition": string, "partIndex": number, "timestampSec": number }], "examRadar": [{ "type": "exam_hint"|"deadline"|"homework", "text": string, "partIndex": number, "timestampSec": number, "dueDate": string|null }] }.',
    'Use 1-based partIndex matching the transcript part where each chapter, definition, or radar item appears.',
  ].join(' ');

  const userContent = [
    {
      type: 'text',
      text: [
        subject ? `Subject: ${subject}` : '',
        courseHint ? `Course/Context hint: ${courseHint}` : '',
        previousLessonSummary
          ? `Previous lesson context (for terminology continuity only): ${previousLessonSummary.slice(0, 1200)}`
          : '',
        'Slide timestamps (0-based index for slideRefs):',
        slideIndex || '(no slides extracted)',
        '\nTimestamped multi-part transcript:\n',
        transcriptSections.join('\n\n'),
      ]
        .filter(Boolean)
        .join('\n'),
    },
    ...allSlides.map((s) => ({ type: 'image_url', image_url: { url: s.dataUrl } })),
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

/**
 * Run Stage 1 STT sequentially across all parts of a Lesson, chaining tail prompts for terminology continuity.
 */
export async function runLessonTranscription({
  lectureIds,
  courseHint,
  force = false,
  onStage = () => {},
  deps = DEFAULT_DEPS,
}) {
  const resolvedDeps = deps === DEFAULT_DEPS ? DEFAULT_DEPS : { ...DEFAULT_DEPS, ...deps };
  const settings = await resolvedDeps.getSettings();
  const transcriptsById = {};
  let prevTail = '';

  for (let i = 0; i < lectureIds.length; i++) {
    const lectureId = lectureIds[i];
    const lecture = await resolvedDeps.getLecture(lectureId);
    if (!lecture) throw new Error(`Lecture ${lectureId} not found`);
    const activeHint = (courseHint ?? lecture.courseHint ?? settings.defaultCourseHint ?? '').trim();
    const subjectOrHint = (lecture.subject || activeHint || lecture.title || '').trim();
    const seedPrompt = [subjectOrHint, prevTail].filter(Boolean).join(': ');

    try {
      const { transcript } = await ensureTranscript({
        lectureId,
        lecture,
        settings,
        activeHint,
        seedPrompt,
        force,
        onStage: (msg) => onStage(`Part ${i + 1}/${lectureIds.length}: ${msg}`),
        resolvedDeps,
      });
      transcriptsById[lectureId] = transcript;
      prevTail = buildTranscriptTailPrompt(transcript?.fullText || '');
      const existingNotes = await resolvedDeps.readLectureJson(lectureId, 'notes.json');
      await resolvedDeps.upsertLecture({
        id: lectureId,
        status: existingNotes ? 'ready' : 'transcribed',
        courseHint: activeHint,
        error: '',
      });
    } catch (err) {
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'error', error: err?.message || String(err) });
      throw err;
    }
  }

  return { transcriptsById };
}

/**
 * Run unified multi-part Lesson pipeline: chained STT -> per-part slides -> unified LLM notes in lessons/<lessonId>/notes.json.
 */
export async function runLessonPipeline({
  lessonId,
  lectureIds,
  subject = '',
  courseHint,
  previousLessonSummary = '',
  onStage = () => {},
  deps = DEFAULT_DEPS,
}) {
  if (!Array.isArray(lectureIds) || lectureIds.length === 0) {
    throw new Error('Lesson has no lecture parts.');
  }
  if (lectureIds.length === 1) {
    const single = await runLecturePipeline({ lectureId: lectureIds[0], courseHint, onStage, deps });
    return {
      notes: single.notes,
      transcriptsById: { [lectureIds[0]]: single.transcript },
      slides: single.slides,
    };
  }

  const resolvedDeps = deps === DEFAULT_DEPS ? DEFAULT_DEPS : { ...DEFAULT_DEPS, ...deps };
  const settings = await resolvedDeps.getSettings();
  const { transcriptsById } = await runLessonTranscription({ lectureIds, courseHint, onStage, deps });

  const partsPayload = [];
  const allSlides = [];
  let activeLectureId = null;

  try {
    for (let i = 0; i < lectureIds.length; i++) {
      const lectureId = lectureIds[i];
      activeLectureId = lectureId;
      const lecture = await resolvedDeps.getLecture(lectureId);
      onStage(`Part ${i + 1}/${lectureIds.length}: Extracting slides...`);
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'extracting_slides' });
      const slides = await ensureSlidesForLecture({
        lectureId,
        lecture,
        onStage: (msg) => onStage(`Part ${i + 1}/${lectureIds.length}: ${msg}`),
        resolvedDeps,
      });

      const slidePayloads = [];
      for (const s of slides) {
        const file = await resolvedDeps.readLectureFile(lectureId, `slides/${s.filename}`);
        const mime = s.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        const payload = {
          partId: lectureId,
          partIndex: i + 1,
          filename: s.filename,
          timestampSec: s.timestampSec,
          dataUrl: await resolvedDeps.blobToDataUrl(file, mime),
        };
        slidePayloads.push(payload);
        allSlides.push({
          partId: lectureId,
          partIndex: i + 1,
          filename: s.filename,
          timestampSec: s.timestampSec,
        });
      }

      partsPayload.push({
        partIndex: i + 1,
        lecture,
        transcript: transcriptsById[lectureId],
        slides: slidePayloads,
      });
    }

    onStage('Generating unified Lesson study notes & Exam Radar...');
    for (const lectureId of lectureIds) {
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'summarizing' });
    }

    const activeHint = (courseHint ?? partsPayload[0]?.lecture?.courseHint ?? settings.defaultCourseHint ?? '').trim();
    const resolvedSubject = (subject || partsPayload[0]?.lecture?.subject || '').trim();
    const messages = buildLessonVisionMessages(partsPayload, {
      courseHint: activeHint,
      subject: resolvedSubject,
      previousLessonSummary,
    });
    const { notes: rawNotes, costUsd } = await resolvedDeps.generateStructuredNotes({ settings, messages });

    const clampPart = (idx) => Math.min(Math.max(1, Number(idx) || 1), lectureIds.length);
    const withPart = (item) => {
      const partIndex = clampPart(item.partIndex);
      return { ...item, partIndex, partId: lectureIds[partIndex - 1] };
    };

    const sttCostUsd = Number(
      Object.values(transcriptsById)
        .reduce((sum, t) => sum + Number(t?.sttCostUsd || 0), 0)
        .toFixed(6)
    );
    const llmCostUsd = Number(costUsd.toFixed(6));
    const notes = {
      ...rawNotes,
      chapters: (rawNotes.chapters || []).map(withPart),
      definitions: (rawNotes.definitions || []).map(withPart),
      examRadar: (rawNotes.examRadar || []).map(withPart),
      isMultiPart: true,
      partsMeta: partsPayload.map((p) => ({
        partIndex: p.partIndex,
        partId: p.lecture.id,
        title: p.lecture.title,
        durationSec: p.lecture.durationSec || 0,
      })),
      slides: allSlides,
      sttCostUsd,
      llmCostUsd,
      totalCostUsd: Number((sttCostUsd + llmCostUsd).toFixed(6)),
      generatedAt: new Date().toISOString(),
    };

    await resolvedDeps.writeLessonJson(lessonId, 'notes.json', notes);
    for (const lectureId of lectureIds) {
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'ready', courseHint: activeHint, error: '' });
    }
    return { notes, transcriptsById, slides: allSlides };
  } catch (err) {
    if (activeLectureId) {
      await resolvedDeps.upsertLecture({ id: activeLectureId, status: 'error', error: err?.message || String(err) });
    }
    throw err;
  }
}
