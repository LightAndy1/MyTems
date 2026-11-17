import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNotesJson,
  fetchWithRetry,
  blobToBase64,
  blobToDataUrl,
  transcribeAudioSegment,
  generateStructuredNotes,
  buildOpenRouterProviderConfig,
} from '../src/dashboard/ai-client.js';
import {
  mergeTranscriptSegments,
  buildVisionMessages,
  runLecturePipeline,
  runTranscriptionOnly,
} from '../src/dashboard/pipeline.js';

describe('AI pipeline & client helpers', () => {
  it('strips markdown fences and validates notes schema', () => {
    const parsed = parseNotesJson('```json\n{"summary":"S","chapters":[],"definitions":[],"examRadar":[]}\n```');
    assert.equal(parsed.summary, 'S');
    assert.deepEqual(parsed.chapters, []);
    assert.deepEqual(parsed.definitions, []);
    assert.deepEqual(parsed.examRadar, []);
    assert.throws(() => parseNotesJson('{"summary":"missing chapters"}'), /Invalid notes JSON/);
  });

  it('retries 429/5xx responses with backoff and succeeds', async () => {
    let calls = 0;
    const delays = [];
    const mockFetch = async () => {
      calls += 1;
      if (calls < 3) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const res = await fetchWithRetry('https://example.test', {}, 3, mockFetch, async (ms) => {
      delays.push(ms);
    });
    assert.equal(calls, 3);
    assert.equal(res.status, 200);
    assert.deepEqual(delays, [500, 1000]);
  });

  it('does not retry 4xx (non-429) responses', async () => {
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    };
    await assert.rejects(
      () => fetchWithRetry('https://example.test', {}, 3, mockFetch, async () => {}),
      /HTTP 400: bad request/
    );
    assert.equal(calls, 1);
  });

  it('retries and rethrows safely when fetchImpl rejects with null', async () => {
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      throw null;
    };
    await assert.rejects(
      () => fetchWithRetry('https://example.test', {}, 2, mockFetch, async () => {}),
      (err) => err === null
    );
    assert.equal(calls, 3);
  });

  it('rejects local STT and LLM calls when local URL is blank', async () => {
    await assert.rejects(
      () =>
        transcribeAudioSegment({
          settings: { providerMode: 'local', localSttUrl: '', localSttModel: 'whisper-1' },
          blob: new Blob(['a']),
          filename: 'part_000.webm',
        }),
      /Missing Local STT URL/
    );
    await assert.rejects(
      () =>
        generateStructuredNotes({
          settings: { providerMode: 'local', localLlmUrl: '   ', localLlmModel: 'qwen' },
          messages: [{ role: 'user', content: 'hi' }],
        }),
      /Missing Local LLM URL/
    );
  });

  it('converts blob to base64 and data URL', async () => {
    const blob = new Blob(['hello'], { type: 'image/jpeg' });
    const b64 = await blobToBase64(blob);
    assert.equal(b64, Buffer.from('hello').toString('base64'));
    const dataUrl = await blobToDataUrl(blob);
    assert.equal(dataUrl, `data:image/jpeg;base64,${b64}`);
  });

  it('transcribes cloud audio without passing a language param', async () => {
    let capturedBody = null;
    let capturedHeaders = null;
    const mockFetch = async (_url, init) => {
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          language: 'ro',
          text: 'Salut lume',
          segments: [{ start: 0, end: 2.5, text: ' Salut lume ' }],
          usage: { cost: 0.015 },
        }),
        { status: 200 }
      );
    };

    const res = await transcribeAudioSegment({
      settings: {
        providerMode: 'cloud',
        openrouterApiKey: 'sk-test',
        sttModel: 'openai/whisper-large-v3',
      },
      blob: new Blob(['audio-bytes'], { type: 'audio/webm' }),
      filename: 'part_000.webm',
      fetchImpl: mockFetch,
    });

    assert.equal(capturedHeaders.Authorization, 'Bearer sk-test');
    assert.equal('language' in capturedBody, false);
    assert.equal(capturedBody.model, 'openai/whisper-large-v3');
    assert.equal(capturedBody.response_format, 'verbose_json');
    assert.equal(res.language, 'ro');
    assert.equal(res.costUsd, 0.015);
    assert.deepEqual(res.segments, [{ startSec: 0, endSec: 2.5, text: 'Salut lume' }]);
  });

  it('transcribes local audio via multipart FormData without language param', async () => {
    let capturedUrl = null;
    let capturedForm = null;
    const mockFetch = async (url, init) => {
      capturedUrl = url;
      capturedForm = init.body;
      return new Response(
        JSON.stringify({
          text: 'Fallback segment text',
          usage: { seconds: 12 },
        }),
        { status: 200 }
      );
    };

    const res = await transcribeAudioSegment({
      settings: {
        providerMode: 'local',
        localSttUrl: 'http://localhost:8080/v1/audio/transcriptions',
        localSttModel: 'whisper-1',
      },
      blob: new Blob(['audio-bytes'], { type: 'audio/webm' }),
      filename: 'part_000.webm',
      fetchImpl: mockFetch,
    });

    assert.equal(capturedUrl, 'http://localhost:8080/v1/audio/transcriptions');
    assert.equal(capturedForm.get('model'), 'whisper-1');
    assert.equal(capturedForm.get('response_format'), 'verbose_json');
    assert.equal(capturedForm.get('language'), null);
    assert.equal(res.language, 'auto');
    assert.deepEqual(res.segments, [{ startSec: 0, endSec: 12, text: 'Fallback segment text' }]);
  });

  it('generates structured notes for cloud and fails without API key', async () => {
    await assert.rejects(
      () =>
        generateStructuredNotes({
          settings: { providerMode: 'cloud', openrouterApiKey: '' },
          messages: [],
        }),
      /Missing OpenRouter API key/
    );

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"summary":"Sum","chapters":[{"title":"Intro","startSec":0,"endSec":60,"bullets":["A"],"formulas":[],"slideRefs":[0]}]}\n```',
              },
            },
          ],
          usage: { cost: 0.04 },
        }),
        { status: 200 }
      );

    const out = await generateStructuredNotes({
      settings: { providerMode: 'cloud', openrouterApiKey: 'sk-test', llmModel: 'google/gemini-2.5-flash' },
      messages: [{ role: 'user', content: 'test' }],
      fetchImpl: mockFetch,
    });
    assert.equal(out.notes.summary, 'Sum');
    assert.equal(out.costUsd, 0.04);
  });

  it('shifts segment timestamps by chunk offset and merges text', () => {
    const merged = mergeTranscriptSegments([
      {
        offsetSec: 0,
        result: {
          language: 'ro',
          text: 'Bună ziua',
          segments: [{ startSec: 0, endSec: 3, text: 'Bună ziua' }],
          costUsd: 0.01,
        },
      },
      {
        offsetSec: 599.7,
        result: {
          language: 'ro',
          text: 'continuăm cu graphs',
          segments: [{ startSec: 1.3, endSec: 4.3, text: 'continuăm cu graphs' }],
          costUsd: 0.01,
        },
      },
    ]);
    assert.equal(merged.segments[1].startSec, 601);
    assert.equal(merged.segments[1].endSec, 604);
    assert.equal(merged.sttCostUsd, 0.02);
    assert.equal(merged.detectedLanguage, 'ro');
    assert.equal(merged.fullText, 'Bună ziua continuăm cu graphs');
  });

  it('builds multimodal vision messages with course hint, slide index, and transcript', () => {
    const messages = buildVisionMessages(
      { segments: [{ startSec: 65, endSec: 70, text: 'AVL rotations' }] },
      [{ filename: '001_60.jpg', timestampSec: 60, dataUrl: 'data:image/jpeg;base64,abc' }],
      'Algorithms'
    );
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /Romanian or English/);
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content[0].type, 'text');
    assert.match(messages[1].content[0].text, /Course\/Context hint: Algorithms/);
    assert.match(messages[1].content[0].text, /Slide #0 @ 01:00 \(60s\)/);
    assert.match(messages[1].content[0].text, /\[01:05 \| 65s\] AVL rotations/);
    assert.deepEqual(messages[1].content[1], {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,abc' },
    });
  });

  it('skips STT when transcript.json already exists (retry checkpoint)', async () => {
    let sttCalls = 0;
    const stored = {
      transcript: {
        segments: [{ startSec: 0, endSec: 5, text: 'Hello' }],
        fullText: 'Hello',
        detectedLanguage: 'en',
        sttCostUsd: 0.02,
      },
      notes: null,
    };
    const res = await runLecturePipeline({
      lectureId: 'lec-1',
      deps: {
        getLecture: async () => ({ id: 'lec-1', courseHint: 'CS', audioSegments: [] }),
        getSettings: async () => ({ providerMode: 'cloud', openrouterApiKey: 'sk' }),
        upsertLecture: async () => {},
        readLectureJson: async (_id, path) => (path === 'transcript.json' ? stored.transcript : null),
        writeLectureJson: async (_id, path, obj) => { stored[path] = obj; },
        readLectureFile: async () => { throw new Error('NotFoundError'); },
        listDirFiles: async () => [],
        transcribeAudioSegment: async () => { sttCalls += 1; },
        extractSlidesFromVideo: async () => [],
        generateStructuredNotes: async () => ({
          notes: { summary: 'Done', chapters: [], definitions: [], examRadar: [] },
          costUsd: 0.03,
        }),
        blobToDataUrl: async () => '',
      },
    });
    assert.equal(sttCalls, 0);
    assert.equal(res.notes.totalCostUsd, 0.05);
    assert.equal(stored['notes.json'].summary, 'Done');
  });

  it('runs full pipeline (STT + slides + notes) and sets ready status', async () => {
    const statuses = [];
    const stages = [];
    const written = {};
    let receivedFallbackDur = null;
    const res = await runLecturePipeline({
      lectureId: 'lec-2',
      courseHint: 'OS',
      onStage: (s) => stages.push(s),
      deps: {
        getLecture: async () => ({
          id: 'lec-2',
          durationSec: 321,
          audioSegments: [{ filename: 'audio/part_000.webm', offsetSec: 0 }],
        }),
        getSettings: async () => ({ providerMode: 'local', localSttModel: 'whisper-1', localLlmModel: 'qwen' }),
        upsertLecture: async (patch) => { statuses.push(patch.status); },
        readLectureJson: async () => null,
        writeLectureJson: async (_id, path, obj) => { written[path] = obj; },
        readLectureFile: async (_id, path) => new Blob([path], { type: 'application/octet-stream' }),
        listDirFiles: async (_id, dir) => (dir === 'slides' ? ['001_15.jpg'] : []),
        transcribeAudioSegment: async () => ({
          text: 'Processes and threads',
          segments: [{ startSec: 0, endSec: 5, text: 'Processes and threads' }],
          language: 'en',
          costUsd: 0,
        }),
        extractSlidesFromVideo: async (_vf, _id, onProg, fallbackDurationSec) => {
          receivedFallbackDur = fallbackDurationSec;
          onProg(0.5);
          return [{ filename: '001_15.jpg', timestampSec: 15 }];
        },
        generateStructuredNotes: async () => ({
          notes: { summary: 'OS summary', chapters: [], definitions: [], examRadar: [] },
          costUsd: 0,
        }),
        blobToDataUrl: async (_b, mime) => `data:${mime};base64,AA==`,
      },
    });

    assert.equal(receivedFallbackDur, 321);
    assert.equal(res.slides.length, 1);
    assert.equal(res.slides[0].timestampSec, 15);
    assert.ok(written['transcript.json']);
    assert.ok(written['notes.json']);
    assert.equal(statuses.at(-1), 'ready');
    assert.ok(stages.includes('Extracting slides (50%)...'));
  });

  it('records error status and rethrows on pipeline failure', async () => {
    const patches = [];
    await assert.rejects(
      () =>
        runLecturePipeline({
          lectureId: 'lec-err',
          deps: {
            getLecture: async () => ({ id: 'lec-err', audioSegments: [] }),
            getSettings: async () => ({ providerMode: 'cloud', openrouterApiKey: '' }),
            upsertLecture: async (p) => { patches.push(p); },
            readLectureJson: async (_id, path) =>
              path === 'transcript.json' ? { segments: [], fullText: '', sttCostUsd: 0 } : null,
            writeLectureJson: async () => {},
            readLectureFile: async () => { throw new Error('NotFoundError'); },
            listDirFiles: async () => [],
            transcribeAudioSegment: async () => {},
            extractSlidesFromVideo: async () => [],
            generateStructuredNotes: async () => { throw new Error('Missing OpenRouter API key in Settings.'); },
            blobToDataUrl: async () => '',
          },
        }),
      /Missing OpenRouter API key/
    );
    assert.deepEqual(patches.at(-1), {
      id: 'lec-err',
      status: 'error',
      error: 'Missing OpenRouter API key in Settings.',
    });
  });

  it('builds OpenRouter provider routing config and sends it on cloud LLM calls', async () => {
    assert.equal(buildOpenRouterProviderConfig({ providerRouting: 'auto', preferredProviders: '' }), undefined);
    assert.deepEqual(
      buildOpenRouterProviderConfig({ providerRouting: 'price', preferredProviders: ' relace , deepinfra ' }),
      { sort: 'price', order: ['relace', 'deepinfra'], allow_fallbacks: true }
    );

    let sentBody = null;
    await generateStructuredNotes({
      settings: {
        providerMode: 'cloud',
        openrouterApiKey: 'sk-test',
        llmModel: 'z-ai/glm-5.3-flash',
        providerRouting: 'price',
        preferredProviders: 'relace',
      },
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"summary":"ok","chapters":[]}' } }] }),
          { status: 200 }
        );
      },
    });
    assert.deepEqual(sentBody.provider, { sort: 'price', order: ['relace'], allow_fallbacks: true });
  });

  it('runs transcription only without calling slide extraction or LLM', async () => {
    let llmCalls = 0;
    let slideCalls = 0;
    const patches = [];
    const written = {};
    const res = await runTranscriptionOnly({
      lectureId: 'lec-stt-only',
      deps: {
        getLecture: async () => ({
          id: 'lec-stt-only',
          audioSegments: [{ filename: 'audio/000.webm', offsetSec: 0 }],
        }),
        getSettings: async () => ({ providerMode: 'cloud', openrouterApiKey: 'sk', sttModel: 'whisper-large-v3' }),
        upsertLecture: async (p) => { patches.push(p); },
        readLectureJson: async () => null,
        writeLectureJson: async (_id, path, obj) => { written[path] = obj; },
        readLectureFile: async () => new Blob(['audio']),
        listDirFiles: async () => [],
        transcribeAudioSegment: async () => ({
          language: 'ro',
          text: 'Test STT',
          segments: [{ startSec: 0, endSec: 2, text: 'Test STT' }],
          costUsd: 0.005,
        }),
        extractSlidesFromVideo: async () => { slideCalls += 1; return []; },
        generateStructuredNotes: async () => { llmCalls += 1; return {}; },
        blobToDataUrl: async () => '',
      },
    });
    assert.equal(llmCalls, 0);
    assert.equal(slideCalls, 0);
    assert.equal(res.transcript.fullText, 'Test STT');
    assert.ok(written['transcript.json']);
    assert.equal(patches.at(-1).status, 'transcribed');
  });
});
