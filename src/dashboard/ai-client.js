import { AI_VENDORS } from '../shared/constants.js';
import { normalizeSettings } from '../shared/storage.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch wrapper with exponential backoff on network errors, 429, and 5xx responses.
 */
export async function fetchWithRetry(url, init, retries = 3, fetchImpl = fetch, sleep = defaultSleep) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
      if (attempt < retries && !String(err?.message || '').startsWith('HTTP 4')) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Convert a Blob to a base64 string without exceeding call-stack argument limits.
 */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Encode a Blob as a base64 data URL.
 */
export async function blobToDataUrl(blob, mimeHint = 'image/jpeg') {
  return `data:${blob.type || mimeHint};base64,${await blobToBase64(blob)}`;
}

function parseJsonContent(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

/**
 * Strip optional markdown code fences and validate structured study notes JSON.
 */
export function parseNotesJson(rawText) {
  const parsed = parseJsonContent(rawText);
  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.chapters)) {
    throw new Error('Invalid notes JSON structure');
  }
  return {
    summary: parsed.summary,
    chapters: parsed.chapters,
    definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
    examRadar: Array.isArray(parsed.examRadar) ? parsed.examRadar : [],
  };
}

function resolveStageRoute(rawSettings, stage) {
  const s = normalizeSettings(rawSettings);
  const vendor =
    stage === 'stt' ? s.sttVendor : stage === 'jev' ? s.jevVendor : s.llmVendor;
  const meta = AI_VENDORS[vendor] || AI_VENDORS.openrouter;
  const key = s.vendorKeys[vendor] || '';

  let model =
    stage === 'stt' ? s.sttModel : stage === 'jev' ? s.jevModel : s.llmModel;
  model = String(model || '').trim();
  if (!model) {
    model =
      stage === 'stt'
        ? meta.defaultSttModel
        : stage === 'jev'
          ? meta.defaultJevModel
          : meta.defaultLlmModel;
  }

  let url = '';
  if (vendor === 'custom') {
    url = (stage === 'stt' ? s.localSttUrl : s.localLlmUrl || '').trim();
  } else if (vendor === 'google') {
    url =
      stage === 'stt'
        ? `${meta.baseUrl}/models/${encodeURIComponent(model)}:generateContent`
        : `${meta.baseUrl}/openai/chat/completions`;
  } else {
    url =
      stage === 'stt'
        ? `${meta.baseUrl}/audio/transcriptions`
        : `${meta.baseUrl}/chat/completions`;
  }

  return { settings: s, vendor, meta, key, model, url };
}

/**
 * Return true when the configured vendor for a pipeline stage has its required key or local URL.
 */
export function hasVendorCredentials(rawSettings, stage = 'llm') {
  const route = resolveStageRoute(rawSettings, stage);
  if (route.vendor === 'custom') return Boolean(route.url);
  return Boolean(route.key);
}

function assertStageCredentials(route, stage) {
  if (route.vendor === 'custom') {
    if (!route.url) {
      throw new Error(stage === 'stt' ? 'Missing Local STT URL in Settings.' : 'Missing Local LLM URL in Settings.');
    }
    return;
  }
  if (!route.key) {
    throw new Error(`Missing ${route.meta.label} API key in Settings.`);
  }
}

function isLikelyGeminiFreeTier(id) {
  const lower = String(id || '').toLowerCase();
  if (!lower) return false;
  if (/pro|ultra|veo|lyria|imagen|nano-banana|carbon|argon|embedding|aqa|tts/.test(lower)) return false;
  return /flash|hydrogen|transcribe|gemma/.test(lower);
}

function deriveModelsUrl(endpointUrl) {
  const clean = String(endpointUrl || '').trim();
  if (!clean) return '';
  if (/\/(audio\/transcriptions|chat\/completions)\/?$/i.test(clean)) {
    return clean.replace(/\/(audio\/transcriptions|chat\/completions)\/?$/i, '/models');
  }
  return `${clean.replace(/\/+$/, '')}/models`;
}

/**
 * Fetch available models live from a vendor API and normalize metadata for stage pickers.
 */
export async function fetchVendorModels({ vendor, settings, stage = 'all', fetchImpl = fetch }) {
  const s = normalizeSettings(settings);
  const meta = AI_VENDORS[vendor];
  if (!meta) throw new Error(`Unknown AI vendor: ${vendor}`);
  const key = s.vendorKeys[vendor] || '';

  if (vendor === 'google') {
    if (!key) throw new Error('Enter Google AI Studio API key first to load live models.');
    const res = await fetchWithRetry(
      `${meta.baseUrl}/models?pageSize=200`,
      { method: 'GET', headers: { 'x-goog-api-key': key } },
      1,
      fetchImpl
    );
    const json = await res.json();
    const list = (Array.isArray(json.models) ? json.models : [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => {
        const id = String(m.name || '').replace(/^models\//, '');
        const isFree = isLikelyGeminiFreeTier(id);
        const supportsAudio = !/imagen|veo|embedding|aqa|tts/i.test(id);
        const supportsVision = !/embedding|aqa|tts|transcribe/i.test(id);
        const recommended = stage === 'stt' ? supportsAudio : stage === 'llm' ? supportsVision : true;
        return {
          id,
          label: m.displayName && m.displayName !== id ? `${m.displayName} (${id})` : id,
          isFree,
          freeLabel: isFree ? 'Free Tier*' : '',
          supportsAudio,
          supportsVision,
          recommended,
          contextLength: Number(m.inputTokenLimit || 0),
        };
      });
    return sortModelsForStage(list, stage);
  }

  let url = '';
  const headers = {};
  if (vendor === 'custom') {
    const refUrl = stage === 'stt' ? s.localSttUrl : s.localLlmUrl || s.localSttUrl;
    url = deriveModelsUrl(refUrl);
    if (!url) throw new Error('Enter a Basement Node URL first.');
    if (key) headers.Authorization = `Bearer ${key}`;
  } else {
    if (meta.requiresKey && vendor !== 'openrouter' && !key) {
      throw new Error(`Enter ${meta.label} API key first to load live models.`);
    }
    url = `${meta.baseUrl}/models`;
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const res = await fetchWithRetry(url, { method: 'GET', headers }, 1, fetchImpl);
  const json = await res.json();
  const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];

  const list = rawList
    .filter((m) => m && m.active !== false)
    .map((m) => {
      const id = String(m.id || m.name || '').trim();
      const inputMods = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
      const promptPrice = Number(m.pricing?.prompt ?? NaN);
      const completionPrice = Number(m.pricing?.completion ?? NaN);
      const isFree =
        vendor === 'openrouter'
          ? (Number.isFinite(promptPrice) && promptPrice === 0 && (!Number.isFinite(completionPrice) || completionPrice === 0)) ||
            id.endsWith(':free')
          : false;
      const supportsAudio =
        inputMods.includes('audio') || /whisper|transcribe|asr|parakeet|canary|audio/i.test(id);
      const supportsVision =
        inputMods.includes('image') || /vision|vl|vlm|gemini|claude-3|claude-4|gpt-4o|gpt-4\.1|gpt-5|llama-4|scout|maverick|llama-3\.2-.*vision|qwen.*vl|cosmos|neva/i.test(id);
      const recommended = stage === 'stt' ? supportsAudio : stage === 'llm' ? supportsVision : true;
      return {
        id,
        label: m.name && m.name !== id ? `${m.name} (${id})` : id,
        isFree,
        freeLabel: isFree ? 'Free ($0)' : '',
        supportsAudio,
        supportsVision,
        recommended,
        contextLength: Number(m.context_length || m.context_window || 0),
      };
    })
    .filter((m) => m.id);

  return sortModelsForStage(list, stage);
}

function sortModelsForStage(models, stage) {
  return [...models].sort((a, b) => {
    if (stage !== 'all' && a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function normalizeSegments(rawSegments, fallbackText, fallbackSeconds = 0) {
  const segments =
    Array.isArray(rawSegments) && rawSegments.length
      ? rawSegments.map((s) => {
          const speaker = String(s.speaker ?? s.speaker_id ?? '').trim();
          return {
            startSec: Number(s.start ?? s.startSec ?? 0),
            endSec: Number(s.end ?? s.endSec ?? s.start ?? s.startSec ?? 0),
            text: String(s.text || '').trim(),
            ...(speaker ? { speaker } : {}),
          };
        })
      : [{ startSec: 0, endSec: Number(fallbackSeconds || 0), text: String(fallbackText || '').trim() }];

  return segments.filter((s) => s.text);
}

async function transcribeWithGoogle({ route, blob, prompt, fetchImpl }) {
  const data = await blobToBase64(blob);
  const instruction = [
    'Transcribe the spoken audio verbatim in its original language (Romanian, English, or mixed), auto-detecting language without translating.',
    prompt ? `Context/terminology hint: ${prompt}` : '',
    'Return ONLY valid JSON: { "language": string, "text": string, "segments": [{ "start": number, "end": number, "text": string }] } with timestamps in seconds.',
  ]
    .filter(Boolean)
    .join(' ');

  const res = await fetchWithRetry(
    route.url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': route.key,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: instruction },
              { inline_data: { mime_type: blob.type || 'audio/webm', data } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    },
    3,
    fetchImpl
  );
  const json = await res.json();
  const rawText = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!rawText) throw new Error('Empty transcription response from Google AI Studio');

  let parsed = null;
  try {
    parsed = parseJsonContent(rawText);
  } catch {
    parsed = { text: rawText, segments: [{ start: 0, end: 0, text: rawText }], language: 'auto' };
  }
  const segments = normalizeSegments(parsed.segments, parsed.text || rawText, 0);
  return {
    text: String(parsed.text || segments.map((s) => s.text).join(' ')).trim(),
    segments,
    language: parsed.language || 'auto',
    costUsd: 0,
  };
}

/**
 * Transcribe one audio chunk via the configured STT vendor (OpenRouter, Google AI Studio, NVIDIA NIM, Groq, or Basement Node).
 * Intentionally omits any `language` field so STT auto-detects RO/EN.
 */
export async function transcribeAudioSegment({ settings, blob, filename, prompt = '', fetchImpl = fetch }) {
  if (settings?.aiEnabled === false) throw new Error('AI is disabled in Settings.');
  const route = resolveStageRoute(settings, 'stt');
  assertStageCredentials(route, 'stt');
  const trimmedPrompt = String(prompt || '').trim();

  if (route.vendor === 'google') {
    return transcribeWithGoogle({ route, blob, prompt: trimmedPrompt, fetchImpl });
  }

  let res;
  if (route.vendor === 'openrouter') {
    const data = await blobToBase64(blob);
    res = await fetchWithRetry(
      route.url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${route.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: route.model,
          input_audio: { data, format: 'webm' },
          response_format: 'verbose_json',
          ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        }),
      },
      3,
      fetchImpl
    );
  } else {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', route.model);
    form.append('response_format', 'verbose_json');
    if (trimmedPrompt) form.append('prompt', trimmedPrompt);
    const headers = route.key ? { Authorization: `Bearer ${route.key}` } : {};
    res = await fetchWithRetry(route.url, { method: 'POST', headers, body: form }, 3, fetchImpl);
  }

  const json = await res.json();
  const segments = normalizeSegments(json.segments, json.text, json.usage?.seconds || json.duration || 0);
  return {
    text: String(json.text || segments.map((s) => s.text).join(' ')).trim(),
    segments,
    language: json.language || 'auto',
    costUsd: Number(json.usage?.cost || 0),
  };
}

/**
 * Build OpenRouter provider routing object from settings, or undefined when default.
 */
export function buildOpenRouterProviderConfig(settings) {
  const order = String(settings?.preferredProviders || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sort =
    settings?.providerRouting === 'price' || settings?.providerRouting === 'throughput'
      ? settings.providerRouting
      : undefined;
  if (!sort && order.length === 0) return undefined;
  return {
    ...(sort ? { sort } : {}),
    ...(order.length ? { order } : {}),
    allow_fallbacks: true,
  };
}

async function runStageChatCompletion({ rawSettings, stage, messages, temperature = 0.2, fetchImpl = fetch }) {
  const route = resolveStageRoute(rawSettings, stage);
  assertStageCredentials(route, stage);
  const headers = { 'Content-Type': 'application/json' };
  if (route.key) headers.Authorization = `Bearer ${route.key}`;
  const provider = route.vendor === 'openrouter' ? buildOpenRouterProviderConfig(route.settings) : undefined;

  const res = await fetchWithRetry(
    route.url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: route.model,
        messages,
        response_format: { type: 'json_object' },
        temperature,
        ...(provider ? { provider } : {}),
      }),
    },
    3,
    fetchImpl
  );
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Empty response from ${route.meta.label}`);
  return {
    content,
    costUsd: Number(json.usage?.cost || 0),
  };
}

/**
 * Generate structured study notes and Exam Radar JSON using the configured LLM/Vision vendor.
 */
export async function generateStructuredNotes({ settings, messages, fetchImpl = fetch }) {
  if (settings?.aiEnabled === false) throw new Error('AI is disabled in Settings.');
  const { content, costUsd } = await runStageChatCompletion({
    rawSettings: settings,
    stage: 'llm',
    messages,
    temperature: 0.2,
    fetchImpl,
  });
  return {
    notes: parseNotesJson(content),
    costUsd,
  };
}

/**
 * Calibrate Exam Radar candidate items using the configured Jev vendor/model.
 */
export async function calibrateExamRadarWithJev(items, transcriptSummary, settings, { fetchImpl = fetch } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: Array.isArray(items) ? items : [], costUsd: 0 };
  }
  if (settings?.aiEnabled === false || !hasVendorCredentials(settings, 'jev')) {
    return { items, costUsd: 0 };
  }

  const { content, costUsd } = await runStageChatCompletion({
    rawSettings: settings,
    stage: 'jev',
    temperature: 0.1,
    fetchImpl,
    messages: [
      {
        role: 'system',
        content: [
          'You calibrate university lecture Exam Radar items (exam hints, deadlines, homework). Assign a calibrated probability "confidence" in [0, 1] per item:',
          '- 0.85–1.0: Explicit homework assignment, submission instructions, firm deadline, or direct statement of what will be on the exam/graded.',
          '- 0.45–0.75: Indirect exam hint or next-lecture syllabus/topic preview.',
          '- 0.0–0.35: Routine live-session logistics (e.g., staying connected, break times) or vague remarks.',
          'Return ONLY valid JSON: { "scores": [{ "index": number, "confidence": number }] }.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          summary: String(transcriptSummary || '').slice(0, 4000),
          items: items.map((item, index) => ({
            index,
            type: item.type,
            text: item.text,
            dueDate: item.dueDate ?? null,
          })),
        }),
      },
    ],
  });

  const parsed = parseJsonContent(content);
  const rawScores = Array.isArray(parsed?.scores) ? parsed.scores : [];
  const scoreByIndex = new Map();
  for (const entry of rawScores) {
    const idx = Number(entry?.index);
    const conf = Number(entry?.confidence);
    if (Number.isInteger(idx) && Number.isFinite(conf)) {
      scoreByIndex.set(idx, Math.max(0, Math.min(1, Number(conf.toFixed(2)))));
    }
  }

  return {
    items: items.map((item, index) =>
      scoreByIndex.has(index) ? { ...item, confidence: scoreByIndex.get(index) } : item
    ),
    costUsd,
  };
}
