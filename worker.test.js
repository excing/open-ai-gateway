import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  buildHealth,
  buildModelList,
  buildResolvedChannel,
  canHaveRequestBody,
  compactObject,
  firstString,
  getGatewayConfig,
  getRequestAdminKey,
  json,
  lowerCaseModelId,
  mapFinishReason,
  mapOpenAIToAISDKParams,
  mapUsage,
  normalizeBaseURL,
  requireAdminAuth,
  resolveChannels,
  routeRequiresAdminAuth,
  safeReadJson,
  sanitizeHeaders,
  shuffleArray,
  withCors,
} from './worker.js';

const adminKey = 'gateway-admin-key';

const baseConfig = {
  channels: [
    {
      name: 'OpenAI Main',
      key: 'openai-main',
      provider: 'openai',
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
      models: [{ code: 'gpt-4o-mini' }],
      headers: {},
    },
    {
      name: 'Groq Llama',
      key: 'groq-llama',
      provider: 'groq',
      apiKey: 'groq-key',
      baseURL: 'https://api.groq.com/openai/v1',
      models: [{ code: 'llama-3.1-8b' }],
      headers: {},
    },
  ],
};

const baseEnv = {
  ADMIN_KEY: adminKey,
  GATEWAY_CONFIG_JSON: JSON.stringify(baseConfig),
};

function authedRequest(url, init = {}) {
  return new Request(url, {
    ...init,
    headers: {
      'x-admin-key': adminKey,
      ...(init.headers || {}),
    },
  });
}

test('OPTIONS returns 204 with CORS headers', async () => {
  const response = await worker.fetch(new Request('https://example.com/healthz', { method: 'OPTIONS' }), baseEnv);

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods') || '', /OPTIONS/);
});

test('unknown routes return 404 with CORS headers', async () => {
  const response = await worker.fetch(new Request('https://example.com/unknown'), baseEnv);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('protected routes require admin auth', async () => {
  const response = await worker.fetch(new Request('https://example.com/healthz'), baseEnv);

  assert.equal(response.status, 401);
  const data = await response.json();
  assert.match(data.error.message, /Unauthorized/);
});

test('healthz returns channel summary with admin auth', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/healthz', { headers: { authorization: `Bearer ${adminKey}` } }),
    baseEnv,
  );

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.channelCount, 2);
  assert.deepEqual(new Set(data.providerTypes), new Set(['openai', 'groq']));
});

test('v1 models returns the configured model list', async () => {
  const response = await worker.fetch(authedRequest('https://example.com/v1/models'), baseEnv);

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'list');
  assert.ok(data.data.some((model) => model.id === 'gpt-4o-mini'));
  assert.ok(data.data.some((model) => model.id === 'llama-3.1-8b'));
});

test('buildModelList dedupes model ids case-insensitively', () => {
  const env = {
    ADMIN_KEY: adminKey,
    GATEWAY_CONFIG_JSON: JSON.stringify({
      channels: [
        { key: 'a', provider: 'openai', models: [{ code: 'gpt-4o-mini' }] },
        { key: 'b', provider: 'openai', models: [{ code: 'GPT-4O-MINI' }] },
      ],
    }),
  };

  const list = buildModelList(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'gpt-4o-mini');
});

test('v1 chat completions rejects missing model', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /`model` is required/);
});

test('v1 chat completions rejects unknown model', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nonexistent-model', messages: [{ role: 'user', content: 'ping' }] }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /No channel supports model/);
});

test('v1 routes other than models or chat completions return 404', async () => {
  const response = await worker.fetch(authedRequest('https://example.com/v1/unknown'), baseEnv);

  assert.equal(response.status, 404);
  const data = await response.json();
  assert.match(data.error.message, /Unsupported API route/);
});

test('normalizeBaseURL trims trailing slashes', () => {
  assert.equal(normalizeBaseURL('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(normalizeBaseURL('https://example.com/v1////'), 'https://example.com/v1');
});

test('sanitizeHeaders drops nullish values and stringifies', () => {
  const headers = sanitizeHeaders({
    authorization: 'Bearer token',
    'x-number': 123,
    empty: null,
    missing: undefined,
  });

  assert.deepEqual(headers, { authorization: 'Bearer token', 'x-number': '123' });
  assert.deepEqual(sanitizeHeaders('nope'), {});
});

test('lowerCaseModelId normalizes strings and ignores non-strings', () => {
  assert.equal(lowerCaseModelId(' GPT-4O-MINI '), 'gpt-4o-mini');
  assert.equal(lowerCaseModelId(123), '');
});

test('firstString returns the first non-empty string', () => {
  assert.equal(firstString(undefined, '', '  ', 'ok', 'later'), 'ok');
  assert.equal(firstString(undefined, null), undefined);
});

test('compactObject removes undefined values', () => {
  assert.deepEqual(compactObject({ a: 1, b: undefined, c: null }), { a: 1, c: null });
});

test('routeRequiresAdminAuth matches /healthz and /v1', () => {
  assert.equal(routeRequiresAdminAuth('/healthz'), true);
  assert.equal(routeRequiresAdminAuth('/v1/models'), true);
  assert.equal(routeRequiresAdminAuth('/other'), false);
});

test('getRequestAdminKey prefers x-admin-key and supports bearer token', () => {
  const direct = new Request('https://example.com', { headers: { 'x-admin-key': 'direct' } });
  assert.equal(getRequestAdminKey(direct), 'direct');

  const bearer = new Request('https://example.com', { headers: { authorization: 'Bearer token-123' } });
  assert.equal(getRequestAdminKey(bearer), 'token-123');
});

test('requireAdminAuth returns error response when key mismatches', async () => {
  const response = requireAdminAuth(new Request('https://example.com'), baseEnv);
  assert.ok(response);
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.match(data.error.message, /Unauthorized/);
});

test('getGatewayConfig throws on missing or invalid json', () => {
  assert.throws(() => getGatewayConfig({ ADMIN_KEY: adminKey }), /Missing `GATEWAY_CONFIG_JSON`/);
  assert.throws(
    () => getGatewayConfig({ ADMIN_KEY: adminKey, GATEWAY_CONFIG_JSON: '{bad json' }),
    /must be valid JSON/,
  );
});

test('buildHealth summarizes providers', () => {
  const health = buildHealth(baseEnv);
  assert.equal(health.ok, true);
  assert.equal(health.channelCount, 2);
  assert.deepEqual(new Set(health.providerTypes), new Set(['openai', 'groq']));
});

test('buildResolvedChannel normalizes baseURL and headers', () => {
  const channel = {
    key: 'openai-main',
    provider: 'openai',
    apiKey: 'sk-openai',
    baseURL: 'https://api.openai.com/v1/',
    headers: { 'x-trace-id': 123, empty: undefined },
  };
  const model = { code: 'gpt-4o-mini' };
  const resolved = buildResolvedChannel(channel, model);

  assert.equal(resolved.baseURL, 'https://api.openai.com/v1');
  assert.deepEqual(resolved.headers, { 'x-trace-id': '123' });
  assert.equal(resolved.model, 'gpt-4o-mini');
  assert.equal(resolved.callType, 'chat');
});

test('resolveChannels picks matching model and preserves callType', () => {
  const env = {
    ADMIN_KEY: adminKey,
    GATEWAY_CONFIG_JSON: JSON.stringify({
      channels: [
        {
          key: 'image-channel',
          provider: 'openai',
          apiKey: 'sk-openai',
          baseURL: 'https://api.openai.com/v1',
          models: [{ code: 'gpt-image-1', callType: 'image_gen' }],
          headers: {},
        },
      ],
    }),
  };

  const [candidate] = resolveChannels({ env, model: 'gpt-image-1', random: () => 0 });
  assert.equal(candidate.model, 'gpt-image-1');
  assert.equal(candidate.callType, 'image_gen');
});

test('shuffleArray keeps all items and returns a new array', () => {
  const items = [1, 2, 3, 4];
  const shuffled = shuffleArray(items, () => 0.5);
  assert.deepEqual(new Set(shuffled), new Set(items));
  assert.notEqual(shuffled, items);
});

test('safeReadJson parses json only when content-type and method allow', async () => {
  const request = new Request('https://example.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  });
  const parsed = await safeReadJson(request);
  assert.deepEqual(parsed, { ok: true });

  const nonJson = new Request('https://example.com', { method: 'POST', body: 'hello' });
  assert.equal(await safeReadJson(nonJson), null);

  const getJson = new Request('https://example.com', { method: 'GET', headers: { 'content-type': 'application/json' } });
  assert.equal(await safeReadJson(getJson), null);
});

test('canHaveRequestBody only allows non-GET/HEAD', () => {
  assert.equal(canHaveRequestBody('GET'), false);
  assert.equal(canHaveRequestBody('HEAD'), false);
  assert.equal(canHaveRequestBody('POST'), true);
});

test('json helper returns response with status and content-type', async () => {
  const response = json({ ok: true }, 201);
  assert.equal(response.status, 201);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  const body = await response.json();
  assert.deepEqual(body, { ok: true });
});

test('withCors appends CORS headers', async () => {
  const response = withCors(new Response('ok', { status: 202 }));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

// -------- mapOpenAIToAISDKParams --------

test('mapOpenAIToAISDKParams maps OpenAI params to AI SDK params', () => {
  const params = mapOpenAIToAISDKParams({
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    max_tokens: 100,
    top_p: 0.9,
    frequency_penalty: 0.5,
    presence_penalty: 0.3,
    seed: 42,
    stop: 'END',
  });

  assert.deepEqual(params.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(params.temperature, 0.7);
  assert.equal(params.maxTokens, 100);
  assert.equal(params.topP, 0.9);
  assert.equal(params.frequencyPenalty, 0.5);
  assert.equal(params.presencePenalty, 0.3);
  assert.equal(params.seed, 42);
  assert.deepEqual(params.stopSequences, ['END']);
});

test('mapOpenAIToAISDKParams prefers max_completion_tokens over max_tokens', () => {
  const params = mapOpenAIToAISDKParams({ max_tokens: 50, max_completion_tokens: 100 });
  assert.equal(params.maxTokens, 100);
});

test('mapOpenAIToAISDKParams returns empty object for null body', () => {
  assert.deepEqual(mapOpenAIToAISDKParams(null), {});
});

// -------- mapFinishReason --------

test('mapFinishReason maps AI SDK reasons to OpenAI reasons', () => {
  assert.equal(mapFinishReason('stop'), 'stop');
  assert.equal(mapFinishReason('length'), 'length');
  assert.equal(mapFinishReason('content-filter'), 'content_filter');
  assert.equal(mapFinishReason('tool-calls'), 'tool_calls');
  assert.equal(mapFinishReason('unknown'), 'stop');
  assert.equal(mapFinishReason(undefined), 'stop');
});

// -------- mapUsage --------

test('mapUsage maps AI SDK usage to OpenAI format', () => {
  assert.deepEqual(mapUsage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }), {
    prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
  });

  assert.deepEqual(mapUsage({ inputTokens: 5, outputTokens: 15, totalTokens: 20 }), {
    prompt_tokens: 5, completion_tokens: 15, total_tokens: 20,
  });

  assert.deepEqual(mapUsage(null), {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  });
});

// -------- v1 endpoint routing --------

test('v1 embeddings endpoint rejects missing model', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
    }),
    baseEnv,
  );
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /`model` is required/);
});

test('v1 images generations endpoint rejects missing model', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    }),
    baseEnv,
  );
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /`model` is required/);
});

test('v1 GET on POST-only routes returns 404', async () => {
  const response = await worker.fetch(authedRequest('https://example.com/v1/chat/completions'), baseEnv);
  assert.equal(response.status, 404);
});
