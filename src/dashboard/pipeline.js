import { resolveNoteMode } from '../shared/constants.js';
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
import { blobToDataUrl, calibrateExamRadarWithJev, generateStructuredNotes, transcribeAudioSegment } from './ai-client.js';

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
  calibrateExamRadarWithJev,
  blobToDataUrl,
};

async function maybeCalibrateExamRadar({ examRadar, summary, settings, resolvedDeps }) {
  if (!settings?.jevEnabled || !settings?.openrouterApiKey || !Array.isArray(examRadar) || examRadar.length === 0) {
    return { items: Array.isArray(examRadar) ? examRadar : [], costUsd: 0 };
  }
  try {
    return await resolvedDeps.calibrateExamRadarWithJev(examRadar, summary, settings);
  } catch {
    return { items: examRadar, costUsd: 0 };
  }
}

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

const BASE_STT_CLEANUP_RULE =
  'The Whisper STT transcript may contain garbled inflections, broken grammar, or phonetically misheard technical terms (due to ASR errors or non-native accents); rewrite into clean prose and NEVER copy awkward or garbled STT phrasing.';

const MODE_NOTE_CONFIG = {
  math: {
    singleRole: 'You are an expert university lecture note-taker.',
    multiRole: 'You are an expert university lecture note-taker synthesizing a multi-part lecture from the same class.',
    rules: [
      "Write notes in natural, idiomatic, grammatically correct academic language matching the lecture's primary spoken language (Romanian or English), preserving English technical terms verbatim.",
      BASE_STT_CLEANUP_RULE,
      'Use slide/whiteboard images and course context to fix transcript errors, but independently verify all mathematical/technical derivations: if the board or speaker contains an algebraic, sign, or factual slip, keep the intended theorem/concept, show the correct step (with a brief note in the lecture\'s language flagging the board error), and preserve variable domains (e.g., $n \\in \\mathbb{N}^*$, $n \\ge 2$).',
      'Format math cleanly: put raw LaTeX (no $ wrappers or backticks) inside "formulas". For "summary", "chapters[].title", "bullets", "definitions", and "examRadar[].text", wrap ALL mathematical expressions—including variables, $P(k)$, subscripts/superscripts, roots, trig terms, and inequalities—in $...$ LaTeX (never use raw ^/_ outside $...$ or Unicode math like ², √, ≤).',
      'Only extract "definitions" when a concept/method is explicitly defined, using its accurate timestamp.',
      'For "examRadar", include only concrete homework, deadlines, submission rules, or explicit exam/grading hints—exclude routine live-call logistics.',
    ],
    chapterExtraSchema: '"formulas": string[]',
  },
  code: {
    singleRole: 'You are an expert programming and computer science lecture note-taker.',
    multiRole: 'You are an expert programming and computer science lecture note-taker synthesizing a multi-part coding lesson from the same class.',
    rules: [
      "Write notes in clear, idiomatic technical language matching the lecture's primary spoken language (Romanian or English), preserving English programming terms, APIs, and identifiers verbatim.",
      BASE_STT_CLEANUP_RULE,
      'Use slide/screen-share images and course context to recover exact code syntax, identifiers, types, file paths, and CLI commands; fix obvious spoken/STT typos in code when clearly identifiable from the slides or language syntax, without inventing unmentioned code.',
      'Format code cleanly: NEVER wrap code, variable names, function/class names, types, CLI flags, commands, or file paths in $...$ or $$...$$ LaTeX/KaTeX. Use inline Markdown backticks (`code`) inside prose ("summary", "chapters[].title", "bullets", "definitions", "examRadar[].text"), and put multi-line code snippets, commands, or config examples into "codeBlocks" as { "language": string, "code": string } (lowercase language tag like "js", "ts", "py", "cpp", "bash", "sql", or "text"; raw code without ``` fences). Leave "formulas" empty ([]) unless there is genuine mathematical notation (e.g., Big-O $O(n \\log n)$ or equations).',
      'Only extract "definitions" when a programming concept, API, or pattern is explicitly explained, using its accurate timestamp.',
      'For "examRadar", include only concrete homework, coding labs, deadlines, submission rules, or explicit exam/grading hints—exclude routine live-call logistics.',
    ],
    chapterExtraSchema: '"formulas": string[], "codeBlocks": [{ "language": string, "code": string }]',
  },
  meeting: {
    singleRole: 'You are an expert meeting note-taker.',
    multiRole: 'You are an expert meeting note-taker synthesizing a multi-part meeting.',
    rules: [
      "Write concise, clear professional notes (not academic lecture prose) matching the meeting's primary spoken language (Romanian or English), preserving English technical, product, and project terms verbatim.",
      BASE_STT_CLEANUP_RULE,
      'Use shared screen/slide images and context to clarify discussed deliverables, names, metrics, and technical terms.',
      'Format cleanly: NEVER wrap code, identifiers, URLs, flags, or commands in $...$ LaTeX/KaTeX—use inline Markdown backticks (`code`). Put any multi-line code, config, or command snippets into "codeBlocks": [{ "language": string, "code": string }] (raw code without ``` fences), and leave "formulas" empty ([]) unless real mathematical equations are discussed.',
      'Use "definitions" only for key decisions, agreed definitions, or resolved questions, with accurate timestamps.',
      'Use "examRadar" for concrete action items, owners, deadlines, or follow-up commitments—exclude routine call logistics (greetings, mic/audio checks).',
    ],
    chapterExtraSchema: '"formulas": string[], "codeBlocks": [{ "language": string, "code": string }]',
  },
};

function buildModeSystemPrompt(noteMode, isMultiPart) {
  const cfg = MODE_NOTE_CONFIG[resolveNoteMode(noteMode)];
  const role = isMultiPart ? cfg.multiRole : cfg.singleRole;
  const partField = isMultiPart ? ' "partIndex": number,' : '';
  const chapterTimingRule = isMultiPart
    ? 'Ensure chapter "startSec"/"endSec" span the full topic within each part through its wrap-up.'
    : 'Ensure chapter "startSec"/"endSec" span the full topic through its final wrap-up.';
  const schema = `Return ONLY valid JSON matching: { "summary": string, "chapters": [{ "title": string,${partField} "startSec": number, "endSec": number, "bullets": string[], ${cfg.chapterExtraSchema}, "slideRefs": number[] }], "definitions": [{ "term": string, "definition": string,${partField} "timestampSec": number }], "examRadar": [{ "type": "exam_hint"|"deadline"|"homework", "text": string,${partField} "timestampSec": number, "dueDate": string|null }] }.`;
  return [
    role,
    ...(isMultiPart ? ['Connect topics across parts coherently without repeating the intro.'] : []),
    ...cfg.rules,
    chapterTimingRule,
    schema,
    ...(isMultiPart ? ['Use 1-based partIndex matching the transcript part where each item appears.'] : []),
  ].join(' ');
}

function trimAtWordEnd(text, maxChars) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

function buildSeedPrompt(lecture, activeHint) {
  if (activeHint) return activeHint;
  const topic = (lecture?.subject || lecture?.title || '').trim();
  return topic ? `University lecture on ${topic}.` : '';
}

/**
 * Seed Chunk 0 up to maxChars, or pin a short domain prefix + clean prior-chunk tail within maxChars.
 */
export function buildSttChunkPrompt(domainPrefix, prevChunkText = '', maxChars = 220) {
  const domain = String(domainPrefix || '').trim().replace(/\s+/g, ' ');
  const tailRaw = String(prevChunkText || '').trim().replace(/\s+/g, ' ');
  if (!domain) return buildTranscriptTailPrompt(tailRaw, maxChars);
  if (!tailRaw) return trimAtWordEnd(domain, maxChars);
  const prefix = trimAtWordEnd(domain, 80);
  const budget = maxChars - prefix.length - 2;
  if (budget <= 20) return trimAtWordEnd(domain, maxChars);
  const tail = buildTranscriptTailPrompt(tailRaw, budget);
  return tail ? `${prefix}: ${tail}` : prefix;
}

/**
 * Build OpenAI-compatible vision chat messages combining transcript and slide frames.
 */
export function buildVisionMessages(transcript, slidePayloads, courseHint = '', noteMode = 'math') {
  const transcriptLines = transcript.segments
    .map((s) => `[${formatTimestamp(s.startSec)} | ${Math.floor(s.startSec)}s] ${s.text}`)
    .join('\n');

  const slideIndex = slidePayloads
    .map((s, idx) => `Slide #${idx} @ ${formatTimestamp(s.timestampSec)} (${Math.floor(s.timestampSec)}s)`)
    .join('\n');

  const system = buildModeSystemPrompt(noteMode, false);

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
  prevTail = '',
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
  let lastChunkText = prevTail;
  for (let i = 0; i < segmentsMeta.length; i++) {
    onStage(`Transcribing part ${i + 1}/${segmentsMeta.length}...`);
    const seg = segmentsMeta[i];
    const blob = await resolvedDeps.readLectureFile(lectureId, seg.filename);
    const prompt = buildSttChunkPrompt(seedPrompt, lastChunkText);
    const result = await resolvedDeps.transcribeAudioSegment({
      settings,
      blob,
      filename: seg.filename.split('/').pop(),
      prompt,
    });
    chunkResults.push({ offsetSec: seg.offsetSec, result });
    if (result?.text) lastChunkText = result.text;
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
 * Extract video slides locally ($0 AI cost) for one or more lectures without running STT or LLM.
 */
export async function runSlidesOnly({
  lectureIds,
  onStage = () => {},
  deps = DEFAULT_DEPS,
}) {
  if (!Array.isArray(lectureIds) || lectureIds.length === 0) {
    throw new Error('No lecture selected for slide extraction.');
  }
  const resolvedDeps = deps === DEFAULT_DEPS ? DEFAULT_DEPS : { ...DEFAULT_DEPS, ...deps };
  const slidesById = {};
  let totalSlides = 0;

  for (let i = 0; i < lectureIds.length; i++) {
    const lectureId = lectureIds[i];
    const lecture = await resolvedDeps.getLecture(lectureId);
    if (!lecture) throw new Error(`Lecture ${lectureId} not found`);
    const prefix = lectureIds.length > 1 ? `Part ${i + 1}/${lectureIds.length}: ` : '';
    try {
      onStage(`${prefix}Extracting slides ($0)...`);
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'extracting_slides', error: '' });
      const slides = await ensureSlidesForLecture({
        lectureId,
        lecture,
        onStage: (msg) => onStage(`${prefix}${msg}`),
        resolvedDeps,
      });
      const [existingNotes, existingTranscript] = await Promise.all([
        resolvedDeps.readLectureJson(lectureId, 'notes.json'),
        resolvedDeps.readLectureJson(lectureId, 'transcript.json'),
      ]);
      const restoredStatus = existingNotes ? 'ready' : existingTranscript ? 'transcribed' : 'recorded';
      await resolvedDeps.upsertLecture({ id: lectureId, status: restoredStatus, error: '' });
      slidesById[lectureId] = slides;
      totalSlides += slides.length;
    } catch (err) {
      await resolvedDeps.upsertLecture({ id: lectureId, status: 'error', error: err?.message || String(err) });
      throw err;
    }
  }

  return { slidesById, totalSlides };
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
    const seedPrompt = buildSeedPrompt(lecture, activeHint);
    const { transcript } = await ensureTranscript({
      lectureId,
      lecture,
      settings,
      activeHint,
      seedPrompt,
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
  noteMode,
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
  const activeMode = resolveNoteMode(noteMode ?? lecture.noteMode);

  try {
    const seedPrompt = buildSeedPrompt(lecture, activeHint);
    const { transcript } = await ensureTranscript({
      lectureId,
      lecture,
      settings,
      activeHint,
      seedPrompt,
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

    const messages = buildVisionMessages(transcript, slidePayloads, activeHint, activeMode);
    const { notes: rawNotes, costUsd } = await resolvedDeps.generateStructuredNotes({ settings, messages });
    const { items: examRadar, costUsd: jevCostUsd } = await maybeCalibrateExamRadar({
      examRadar: rawNotes.examRadar,
      summary: rawNotes.summary,
      settings,
      resolvedDeps,
    });
    const totalLlmCost = costUsd + jevCostUsd;
    const notes = {
      ...rawNotes,
      noteMode: activeMode,
      examRadar,
      slides,
      sttCostUsd: transcript.sttCostUsd || 0,
      llmCostUsd: Number(totalLlmCost.toFixed(6)),
      totalCostUsd: Number(((transcript.sttCostUsd || 0) + totalLlmCost).toFixed(6)),
      generatedAt: new Date().toISOString(),
    };
    await resolvedDeps.writeLectureJson(lectureId, 'notes.json', notes);
    await resolvedDeps.upsertLecture({
      id: lectureId,
      status: 'ready',
      courseHint: activeHint,
      noteMode: activeMode,
      error: '',
    });
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
  { courseHint = '', subject = '', previousLessonSummary = '', noteMode = 'math' } = {}
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

  const system = buildModeSystemPrompt(noteMode, true);

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
    const subjectOrHint = buildSeedPrompt(lecture, activeHint);

    try {
      const { transcript } = await ensureTranscript({
        lectureId,
        lecture,
        settings,
        activeHint,
        seedPrompt: subjectOrHint,
        prevTail,
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
  noteMode,
  previousLessonSummary = '',
  onStage = () => {},
  deps = DEFAULT_DEPS,
}) {
  if (!Array.isArray(lectureIds) || lectureIds.length === 0) {
    throw new Error('Lesson has no lecture parts.');
  }
  if (lectureIds.length === 1) {
    const single = await runLecturePipeline({ lectureId: lectureIds[0], courseHint, noteMode, onStage, deps });
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
    const activeMode = resolveNoteMode(noteMode ?? partsPayload[0]?.lecture?.noteMode);
    const resolvedSubject = (subject || partsPayload[0]?.lecture?.subject || '').trim();
    const messages = buildLessonVisionMessages(partsPayload, {
      courseHint: activeHint,
      subject: resolvedSubject,
      previousLessonSummary,
      noteMode: activeMode,
    });
    const { notes: rawNotes, costUsd } = await resolvedDeps.generateStructuredNotes({ settings, messages });

    const clampPart = (idx) => Math.min(Math.max(1, Number(idx) || 1), lectureIds.length);
    const withPart = (item) => {
      const partIndex = clampPart(item.partIndex);
      return { ...item, partIndex, partId: lectureIds[partIndex - 1] };
    };

    const taggedExamRadar = (rawNotes.examRadar || []).map(withPart);
    const { items: examRadar, costUsd: jevCostUsd } = await maybeCalibrateExamRadar({
      examRadar: taggedExamRadar,
      summary: rawNotes.summary,
      settings,
      resolvedDeps,
    });
    const sttCostUsd = Number(
      Object.values(transcriptsById)
        .reduce((sum, t) => sum + Number(t?.sttCostUsd || 0), 0)
        .toFixed(6)
    );
    const llmCostUsd = Number((costUsd + jevCostUsd).toFixed(6));
    const notes = {
      ...rawNotes,
      noteMode: activeMode,
      chapters: (rawNotes.chapters || []).map(withPart),
      definitions: (rawNotes.definitions || []).map(withPart),
      examRadar,
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
      await resolvedDeps.upsertLecture({
        id: lectureId,
        status: 'ready',
        courseHint: activeHint,
        noteMode: activeMode,
        error: '',
      });
    }
    return { notes, transcriptsById, slides: allSlides };
  } catch (err) {
    if (activeLectureId) {
      await resolvedDeps.upsertLecture({ id: activeLectureId, status: 'error', error: err?.message || String(err) });
    }
    throw err;
  }
}
