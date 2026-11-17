import { OPENROUTER_URLS } from '../shared/constants.js';

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
      if (attempt < retries && !String(err.message).startsWith('HTTP 4')) {
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

/**
 * Strip optional markdown code fences and validate structured study notes JSON.
 */
export function parseNotesJson(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
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

/**
 * Transcribe one audio chunk via OpenRouter or a local OpenAI-compatible STT endpoint.
 * Intentionally omits any `language` field so Whisper auto-detects RO/EN.
 */
export async function transcribeAudioSegment({ settings, blob, filename, fetchImpl = fetch }) {
  const isLocal = settings.providerMode === 'local';
  let res;
  if (isLocal) {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', settings.localSttModel);
    form.append('response_format', 'verbose_json');
    res = await fetchWithRetry(settings.localSttUrl, { method: 'POST', body: form }, 3, fetchImpl);
  } else {
    if (!settings.openrouterApiKey) throw new Error('Missing OpenRouter API key in Settings.');
    const data = await blobToBase64(blob);
    res = await fetchWithRetry(
      OPENROUTER_URLS.TRANSCRIPTIONS,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.openrouterApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: settings.sttModel,
          input_audio: { data, format: 'webm' },
          response_format: 'verbose_json',
        }),
      },
      3,
      fetchImpl
    );
  }
  const json = await res.json();
  const segments =
    Array.isArray(json.segments) && json.segments.length
      ? json.segments.map((s) => ({
          startSec: Number(s.start ?? 0),
          endSec: Number(s.end ?? s.start ?? 0),
          text: String(s.text || '').trim(),
        }))
      : [{ startSec: 0, endSec: Number(json.usage?.seconds || 0), text: String(json.text || '').trim() }];

  return {
    text: String(json.text || segments.map((s) => s.text).join(' ')).trim(),
    segments: segments.filter((s) => s.text),
    language: json.language || 'auto',
    costUsd: Number(json.usage?.cost || 0),
  };
}

/**
 * Generate structured study notes and Exam Radar JSON from multimodal chat messages.
 */
export async function generateStructuredNotes({ settings, messages, fetchImpl = fetch }) {
  const isLocal = settings.providerMode === 'local';
  const url = isLocal ? settings.localLlmUrl : OPENROUTER_URLS.CHAT;
  const headers = { 'Content-Type': 'application/json' };
  if (!isLocal) {
    if (!settings.openrouterApiKey) throw new Error('Missing OpenRouter API key in Settings.');
    headers.Authorization = `Bearer ${settings.openrouterApiKey}`;
  }
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: isLocal ? settings.localLlmModel : settings.llmModel,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    },
    3,
    fetchImpl
  );
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from LLM');
  return {
    notes: parseNotesJson(content),
    costUsd: Number(json.usage?.cost || 0),
  };
}
