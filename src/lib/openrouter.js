import { OPENROUTER_URL } from './constants.js';
import { buildSystemPrompt, parseGatekeeperResponse } from './prompt.js';

// Remembers per-model reasoning fallback ('low' | 'omit') when a model rejects
// reasoning: { enabled: false } (e.g. mandatory-reasoning models like Gemini 4 Neon).
const reasoningFallbackCache = new Map();

const REASONING_ERROR_PATTERN =
  /reason|think|effort|cannot be disabled|mandatory|unsupported param/i;

export function resetReasoningFallbackCache() {
  reasoningFallbackCache.clear();
}

function getReasoningConfig(mode) {
  if (mode === 'off') return { enabled: false };
  if (mode === 'low') return { effort: 'low' };
  return null;
}

function getNextReasoningFallback(currentMode, status, errorMessage) {
  if (status !== 400) return null;
  if (!REASONING_ERROR_PATTERN.test(errorMessage || '')) return null;
  if (currentMode === 'off') return 'low';
  if (currentMode === 'low') return 'omit';
  return null;
}

/**
 * Extract text content from an OpenRouter chat completion payload.
 * Handles string content, array content parts, and reasoning-exhaustion diagnostics.
 */
export function extractOpenRouterContent(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Empty or invalid JSON response from OpenRouter.');
  }

  // OpenRouter can return an error object even with HTTP 200
  if (payload.error) {
    const errMsg =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error.message || JSON.stringify(payload.error);
    throw new Error(errMsg);
  }

  const choice = payload.choices?.[0];
  if (!choice) {
    throw new Error('OpenRouter returned no choices in response.');
  }

  const rawContent = choice.message?.content ?? choice.text;
  let content = '';

  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    content = rawContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }

  return {
    content,
    finishReason: choice.finish_reason || null,
    hasReasoning: Boolean(choice.message?.reasoning || choice.message?.reasoning_details),
    modelUsed: payload.model || '',
    usage: payload.usage || null,
  };
}

/**
 * Call OpenRouter chat completions API.
 */
async function callOpenRouter({
  apiKey,
  model,
  messages,
  maxTokens = 2048,
  temperature = 0.4,
  disableThinking = false,
  reasoningMode = null,
  allowRetryOnLength = true,
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('OpenRouter API key is not configured. Add it in Settings.');
  }
  if (!model || !model.trim()) {
    throw new Error('No OpenRouter model configured. Enter a model ID in Settings.');
  }

  const trimmedModel = model.trim();
  const modelKey = trimmedModel.toLowerCase();
  const activeReasoningMode = disableThinking
    ? reasoningMode || reasoningFallbackCache.get(modelKey) || 'off'
    : 'default';

  const body = {
    model: trimmedModel,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const reasoningConfig = getReasoningConfig(activeReasoningMode);
  if (reasoningConfig) {
    body.reasoning = reasoningConfig;
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/intentional-block',
      'X-Title': 'Intentional Block',
    },
    body: JSON.stringify(body),
  });

  let payload = null;
  const rawText = await response.text();
  try {
    payload = JSON.parse(rawText);
  } catch {
    // Non-JSON response
  }

  if (!response.ok) {
    const apiErr =
      payload?.error?.message ||
      payload?.message ||
      (rawText ? `OpenRouter HTTP ${response.status}: ${rawText.slice(0, 200)}` : `OpenRouter returned HTTP ${response.status}`);

    const nextMode = disableThinking
      ? getNextReasoningFallback(activeReasoningMode, response.status, apiErr)
      : null;
    if (nextMode) {
      reasoningFallbackCache.set(modelKey, nextMode);
      return callOpenRouter({
        apiKey,
        model: trimmedModel,
        messages,
        maxTokens,
        temperature,
        disableThinking,
        reasoningMode: nextMode,
        allowRetryOnLength,
      });
    }

    throw new Error(apiErr);
  }

  const extracted = extractOpenRouterContent(payload);

  // Reasoning models (e.g. Gemini 2.5 Flash) can exhaust max_tokens during thinking
  // and return null/empty content with finish_reason="length". Retry once with higher cap.
  if (!extracted.content.trim() && extracted.finishReason === 'length' && allowRetryOnLength) {
    return callOpenRouter({
      apiKey,
      model: trimmedModel,
      messages,
      maxTokens: Math.max(maxTokens * 2, 4096),
      temperature,
      disableThinking,
      reasoningMode: activeReasoningMode,
      allowRetryOnLength: false,
    });
  }

  if (!extracted.content.trim()) {
    console.warn('[Intentional Block] Empty OpenRouter content payload:', payload);
    const reasonHint = extracted.finishReason ? ` (finish_reason: ${extracted.finishReason})` : '';
    throw new Error(
      `Model returned an empty response${reasonHint}. Try increasing max tokens or choosing a different model in Settings.`
    );
  }

  return {
    content: extracted.content,
    modelUsed: extracted.modelUsed || trimmedModel,
    reasoningMode: activeReasoningMode,
    usage: extracted.usage,
  };
}

/**
 * Evaluate a user's single stated intention via OpenRouter.
 */
export async function evaluateIntention({ site, targetUrl, settings, history, intention, chatMessages }) {
  const systemPrompt = buildSystemPrompt({
    site,
    targetUrl,
    settings,
    history,
  });

  const userIntention =
    typeof intention === 'string' && intention.trim()
      ? intention.trim()
      : ([...(chatMessages || [])].reverse().find((m) => m.role === 'user')?.content || '').trim();

  if (!userIntention) {
    throw new Error('Please state an intention before submitting.');
  }

  const { content, modelUsed, reasoningMode } = await callOpenRouter({
    apiKey: settings.apiKey,
    model: settings.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userIntention },
    ],
    maxTokens: 2048,
    temperature: 0.4,
    disableThinking: Boolean(settings.disableThinking),
  });

  const decision = parseGatekeeperResponse(content, settings.maxMinutes);
  return {
    ...decision,
    modelUsed,
    reasoningMode,
  };
}

/**
 * Test OpenRouter connectivity with the supplied API key and model.
 */
export async function testOpenRouterConnection({ apiKey, model, disableThinking = false }) {
  const { content, modelUsed, reasoningMode } = await callOpenRouter({
    apiKey,
    model,
    messages: [
      { role: 'system', content: 'Reply with only the word OK.' },
      { role: 'user', content: 'Connection test.' },
    ],
    maxTokens: 512,
    temperature: 0,
    disableThinking: Boolean(disableThinking),
  });

  return {
    ok: true,
    modelUsed,
    reasoningMode,
    reply: content.trim(),
  };
}
