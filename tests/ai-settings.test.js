import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { normalizeSettings } from '../src/shared/storage.js';
import {
  calibrateExamRadarWithJev,
  fetchVendorModels,
  generateStructuredNotes,
  transcribeAudioSegment,
} from '../src/dashboard/ai-client.js';

describe('AI toggle, multi-vendor dispatch & live model discovery', () => {
  test('DEFAULT_SETTINGS enables AI by default and defaults per-stage vendors cleanly', () => {
    expect(DEFAULT_SETTINGS.aiEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.expertMode).toBe(false);
    expect(DEFAULT_SETTINGS.sttVendor).toBe('openrouter');
    expect(DEFAULT_SETTINGS.llmVendor).toBe('openrouter');
    expect(DEFAULT_SETTINGS.jevVendor).toBe('openrouter');
  });

  test('normalizeSettings migrates legacy local/openrouter settings without losing keys', () => {
    const legacyLocal = normalizeSettings({
      providerMode: 'local',
      openrouterApiKey: 'sk-or-legacy',
      localSttModel: 'whisper-custom',
      localLlmModel: 'qwen-vl-custom',
    });
    expect(legacyLocal.sttVendor).toBe('custom');
    expect(legacyLocal.llmVendor).toBe('custom');
    expect(legacyLocal.sttModel).toBe('whisper-custom');
    expect(legacyLocal.llmModel).toBe('qwen-vl-custom');
    expect(legacyLocal.vendorKeys.openrouter).toBe('sk-or-legacy');
  });

  test('AI client functions block network calls when aiEnabled is false', async () => {
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    };
    const settings = { ...DEFAULT_SETTINGS, aiEnabled: false, openrouterApiKey: 'sk-or-test' };

    await expect(
      transcribeAudioSegment({
        settings,
        blob: new Blob(['audio'], { type: 'audio/webm' }),
        filename: 'seg-0.webm',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow('AI is disabled in Settings.');

    await expect(
      generateStructuredNotes({
        settings,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow('AI is disabled in Settings.');

    const items = [{ type: 'exam_hint', text: 'Midterm Friday', timestampSec: 10, dueDate: null }];
    const jevRes = await calibrateExamRadarWithJev(items, 'Summary', settings, { fetchImpl: mockFetch });
    expect(jevRes).toEqual({ items, costUsd: 0 });
    expect(fetchCalled).toBe(false);
  });

  test('routes STT to Groq, Summary/Vision to Google AI Studio, and Jev to NVIDIA NIM independently', async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('api.groq.com')) {
        return new Response(
          JSON.stringify({
            text: 'Buna ziua',
            language: 'ro',
            segments: [{ start: 0, end: 1.5, text: 'Buna ziua' }],
          }),
          { status: 200 }
        );
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ summary: 'Sum', chapters: [], definitions: [], examRadar: [] }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('integrate.api.nvidia.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ scores: [{ index: 0, confidence: 0.91 }] }) } }],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const settings = {
      ...DEFAULT_SETTINGS,
      vendorKeys: { groq: 'gsk-test', google: 'AIza-test', nvidia: 'nvapi-test' },
      sttVendor: 'groq',
      sttModel: 'whisper-large-v3-turbo',
      llmVendor: 'google',
      llmModel: 'gemini-3.5-flash',
      jevEnabled: true,
      jevVendor: 'nvidia',
      jevModel: 'meta/llama-3.1-8b-instruct',
    };

    const stt = await transcribeAudioSegment({
      settings,
      blob: new Blob(['webm'], { type: 'audio/webm' }),
      filename: 'part_000.webm',
      fetchImpl: mockFetch,
    });
    expect(stt.text).toBe('Buna ziua');
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer gsk-test');
    expect(calls[0].init.body).toBeInstanceOf(FormData);

    const llm = await generateStructuredNotes({
      settings,
      messages: [{ role: 'user', content: 'notes' }],
      fetchImpl: mockFetch,
    });
    expect(llm.notes.summary).toBe('Sum');
    expect(calls[1].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(calls[1].init.headers.Authorization).toBe('Bearer AIza-test');

    const jev = await calibrateExamRadarWithJev(
      [{ type: 'deadline', text: 'HW1', timestampSec: 5, dueDate: '2026-12-01' }],
      'Sum',
      settings,
      { fetchImpl: mockFetch }
    );
    expect(jev.items[0].confidence).toBe(0.91);
    expect(calls[2].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(calls[2].init.headers.Authorization).toBe('Bearer nvapi-test');
  });

  test('transcribes audio natively via Google AI Studio generateContent and parses segments', async () => {
    let capturedUrl = '';
    let capturedHeaders = null;
    const mockFetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      language: 'ro',
                      text: 'Astazi discutam grafuri',
                      segments: [{ start: 1.2, end: 4.5, text: 'Astazi discutam grafuri' }],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    const res = await transcribeAudioSegment({
      settings: {
        vendorKeys: { google: 'AIza-stt' },
        sttVendor: 'google',
        sttModel: 'gemini-3.5-flash',
      },
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      filename: 'part_000.webm',
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
    expect(capturedHeaders['x-goog-api-key']).toBe('AIza-stt');
    expect(res.language).toBe('ro');
    expect(res.segments).toEqual([{ startSec: 1.2, endSec: 4.5, text: 'Astazi discutam grafuri' }]);
  });

  test('fetchVendorModels queries live APIs for OpenRouter, Google AI Studio, NVIDIA NIM, Groq, and Basement Node', async () => {
    const mockFetch = async (url, init) => {
      if (url.startsWith('https://openrouter.ai/api/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'paid/model', pricing: { prompt: '0.001', completion: '0.002' }, architecture: { input_modalities: ['text', 'image'] } },
              { id: 'google/gemini-2.0-flash:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] } },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) {
        expect(init.headers['x-goog-api-key']).toBe('AIza-live');
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
              { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
              { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 2000000 },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === 'https://integrate.api.nvidia.com/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-transcribe' }, { id: 'meta/llama-3.2-90b-vision-instruct' }] }), { status: 200 });
      }
      if (url === 'https://api.groq.com/openai/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'whisper-large-v3-turbo', active: true }, { id: 'retired-model', active: false }] }),
          { status: 200 }
        );
      }
      if (url === 'http://localhost:11434/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const settings = {
      vendorKeys: { openrouter: 'sk-or', google: 'AIza-live', nvidia: 'nvapi', groq: 'gsk' },
      localLlmUrl: 'http://localhost:11434/v1/chat/completions',
    };

    const orModels = await fetchVendorModels({ vendor: 'openrouter', settings, stage: 'llm', fetchImpl: mockFetch });
    expect(orModels[0].id).toBe('google/gemini-2.0-flash:free');
    expect(orModels[0].isFree).toBe(true);

    const gModels = await fetchVendorModels({ vendor: 'google', settings, stage: 'llm', fetchImpl: mockFetch });
    expect(gModels.map((m) => m.id)).toEqual(['gemini-3.5-flash', 'gemini-3.1-pro-preview']);
    expect(gModels[0].freeLabel).toBe('Free Tier*');
    expect(gModels[1].freeLabel).toBe('');

    const nimModels = await fetchVendorModels({ vendor: 'nvidia', settings, stage: 'stt', fetchImpl: mockFetch });
    expect(nimModels[0].id).toBe('nvidia/nemotron-transcribe');
    expect(nimModels[0].supportsAudio).toBe(true);

    const groqModels = await fetchVendorModels({ vendor: 'groq', settings, stage: 'stt', fetchImpl: mockFetch });
    expect(groqModels.map((m) => m.id)).toEqual(['whisper-large-v3-turbo']);

    const localModels = await fetchVendorModels({ vendor: 'custom', settings, stage: 'llm', fetchImpl: mockFetch });
    expect(localModels.map((m) => m.id)).toEqual(['qwen2.5vl:7b']);
  });
});
