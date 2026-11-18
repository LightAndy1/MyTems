import { describe, expect, test } from 'bun:test';
import { calibrateExamRadarWithJev } from '../src/dashboard/ai-client.js';

describe('calibrateExamRadarWithJev', () => {
  test('sends exam radar items to OpenRouter with typesafe/jev-latest and attaches calibrated confidence', async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  scores: [
                    { index: 0, confidence: 0.94 },
                    { index: 1, confidence: 0.62 },
                  ],
                }),
              },
            },
          ],
          usage: { cost: 0.0004 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const items = [
      { type: 'exam_hint', text: 'Midterm covers chapters 1-3', timestampSec: 120, dueDate: null },
      { type: 'homework', text: 'Read paper by Friday', timestampSec: 340, dueDate: '2026-11-20' },
    ];
    const settings = { openrouterApiKey: 'sk-or-test', jevModel: 'typesafe/jev-latest' };

    const result = await calibrateExamRadarWithJev(items, 'Lecture about algorithms.', settings, {
      fetchImpl: mockFetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-or-test');
    expect(calls[0].init.body.model).toBe('typesafe/jev-latest');
    expect(calls[0].init.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].init.body.messages[0].content).toContain('0.85–1.0');

    expect(result.costUsd).toBe(0.0004);
    expect(result.items).toEqual([
      { ...items[0], confidence: 0.94 },
      { ...items[1], confidence: 0.62 },
    ]);
  });

  test('skips network call when items array is empty', async () => {
    let called = false;
    const result = await calibrateExamRadarWithJev([], 'Summary', { openrouterApiKey: 'sk-or-test' }, {
      fetchImpl: async () => {
        called = true;
        throw new Error('should not fetch');
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ items: [], costUsd: 0 });
  });
});
