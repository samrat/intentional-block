import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOpenRouterContent,
  resetReasoningFallbackCache,
  testOpenRouterConnection,
} from '../src/lib/openrouter.js';

describe('extractOpenRouterContent', () => {
  it('extracts standard string content', () => {
    const res = extractOpenRouterContent({
      model: 'google/gemini-2.5-flash',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    });
    assert.equal(res.content, 'OK');
    assert.equal(res.finishReason, 'stop');
    assert.equal(res.modelUsed, 'google/gemini-2.5-flash');
  });

  it('extracts array content parts', () => {
    const res = extractOpenRouterContent({
      model: 'anthropic/claude-sonnet-4',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '{"decision":"approve",' },
              { type: 'text', text: '"minutes":5}' },
            ],
          },
        },
      ],
    });
    assert.equal(res.content, '{"decision":"approve","minutes":5}');
  });

  it('handles null content from reasoning token exhaustion cleanly', () => {
    const res = extractOpenRouterContent({
      model: 'google/gemini-2.5-flash',
      choices: [
        {
          finish_reason: 'length',
          message: {
            role: 'assistant',
            content: null,
            reasoning: 'Thinking about the request...',
          },
        },
      ],
    });
    assert.equal(res.content, '');
    assert.equal(res.finishReason, 'length');
    assert.equal(res.hasReasoning, true);
  });

  it('throws API error even on HTTP 200 error payloads', () => {
    assert.throws(
      () =>
        extractOpenRouterContent({
          error: { code: 402, message: 'Insufficient credits' },
        }),
      /Insufficient credits/
    );
  });
});

describe('disableThinking reasoning behavior', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetReasoningFallbackCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockJsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }

  it('omits reasoning field when disableThinking is false', async () => {
    const sentBodies = [];
    globalThis.fetch = async (_url, opts) => {
      sentBodies.push(JSON.parse(opts.body));
      return mockJsonResponse(200, {
        model: 'google/gemini-4-neon',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      });
    };

    const res = await testOpenRouterConnection({
      apiKey: 'sk-test',
      model: 'google/gemini-4-neon',
      disableThinking: false,
    });

    assert.equal(res.ok, true);
    assert.equal(res.reasoningMode, 'default');
    assert.equal(sentBodies.length, 1);
    assert.equal('reasoning' in sentBodies[0], false);
  });

  it('sends reasoning.enabled=false when disableThinking is true', async () => {
    const sentBodies = [];
    globalThis.fetch = async (_url, opts) => {
      sentBodies.push(JSON.parse(opts.body));
      return mockJsonResponse(200, {
        model: 'google/gemini-2.5-flash',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      });
    };

    const res = await testOpenRouterConnection({
      apiKey: 'sk-test',
      model: 'google/gemini-2.5-flash',
      disableThinking: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.reasoningMode, 'off');
    assert.deepEqual(sentBodies[0].reasoning, { enabled: false });
  });

  it('falls back to effort=low and caches it when reasoning is mandatory (e.g. Gemini 4 Neon)', async () => {
    const sentBodies = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      sentBodies.push(body);
      if (body.reasoning?.enabled === false) {
        return mockJsonResponse(400, {
          error: {
            message: 'Reasoning is mandatory for this endpoint and cannot be disabled.',
            code: 400,
          },
        });
      }
      return mockJsonResponse(200, {
        model: 'google/gemini-4-neon',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      });
    };

    const first = await testOpenRouterConnection({
      apiKey: 'sk-test',
      model: 'google/gemini-4-neon',
      disableThinking: true,
    });

    assert.equal(first.ok, true);
    assert.equal(first.reasoningMode, 'low');
    assert.equal(sentBodies.length, 2);
    assert.deepEqual(sentBodies[0].reasoning, { enabled: false });
    assert.deepEqual(sentBodies[1].reasoning, { effort: 'low' });

    // Second call should hit effort: 'low' directly from cache without retrying 400
    const second = await testOpenRouterConnection({
      apiKey: 'sk-test',
      model: 'google/gemini-4-neon',
      disableThinking: true,
    });

    assert.equal(second.ok, true);
    assert.equal(second.reasoningMode, 'low');
    assert.equal(sentBodies.length, 3);
    assert.deepEqual(sentBodies[2].reasoning, { effort: 'low' });
  });

  it('falls back to omitting reasoning when provider rejects both enabled=false and effort=low', async () => {
    const sentBodies = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      sentBodies.push(body);
      if (body.reasoning) {
        return mockJsonResponse(400, {
          error: { message: 'Unsupported parameter: reasoning' },
        });
      }
      return mockJsonResponse(200, {
        model: 'vendor/non-reasoning-model',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      });
    };

    const res = await testOpenRouterConnection({
      apiKey: 'sk-test',
      model: 'vendor/non-reasoning-model',
      disableThinking: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.reasoningMode, 'omit');
    assert.equal(sentBodies.length, 3);
    assert.deepEqual(sentBodies[0].reasoning, { enabled: false });
    assert.deepEqual(sentBodies[1].reasoning, { effort: 'low' });
    assert.equal('reasoning' in sentBodies[2], false);
  });

  it('does not retry on unrelated HTTP 400 errors', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return mockJsonResponse(400, {
        error: { message: 'google/bad-model is not a valid model ID' },
      });
    };

    await assert.rejects(
      () =>
        testOpenRouterConnection({
          apiKey: 'sk-test',
          model: 'google/bad-model',
          disableThinking: true,
        }),
      /not a valid model ID/
    );
    assert.equal(calls, 1);
  });
});
