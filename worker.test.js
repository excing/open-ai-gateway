import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker, { buildAiSdkRequest, createModelFromProvider, getProviders, resolveProvider } from './worker.js';

const indexHtml = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

const baseConfig = {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o-mini',
  modelProviderMap: { 'gemini-2.5-flash': 'google' },
  providers: {
    openai: { apiKey: 'sk-openai', models: ['gpt-4o-mini'] },
    google: { apiKey: 'google-key', models: ['gemini-2.5-flash'] },
    anthropic: { apiKey: 'anthropic-key', models: ['claude-3-5-sonnet-latest'] },
    openrouter: { apiKey: 'openrouter-key', models: ['openai/gpt-4o-mini'] },
    pollinations: { apiKey: 'pollinations-key', models: ['openai'] },
  },
};

const baseEnv = {
  GATEWAY_CONFIG_JSON: JSON.stringify(baseConfig),
};

function buildApiCall(body, { requestHeaders = {}, url = 'https://example.com/api/generate' } = {}) {
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...requestHeaders },
  });

  return buildAiSdkRequest({
    body,
    env: baseEnv,
    request,
    url: new URL(url),
  });
}

test('getProviders returns configured AI SDK providers', () => {
  const providers = getProviders(baseEnv);

  assert.equal(providers.openai.kind, 'openai');
  assert.equal(providers.google.kind, 'google');
  assert.equal(providers.anthropic.kind, 'anthropic');
  assert.equal(providers.openrouter.kind, 'openrouter');
  assert.equal(providers.pollinations.kind, 'pollinations');
});

test('createModelFromProvider returns a language model instance', () => {
  const resolved = createModelFromProvider('openai', 'gpt-4o-mini', baseEnv);

  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.kind, 'openai');
  assert.equal(resolved.model, 'gpt-4o-mini');
  assert.equal(typeof resolved.languageModel?.doGenerate, 'function');
});

test('resolveProvider respects modelProviderMap', () => {
  const resolved = resolveProvider({ env: baseEnv, model: 'gemini-2.5-flash' });

  assert.equal(resolved.provider, 'google');
  assert.equal(resolved.kind, 'google');
  assert.equal(resolved.supportsGatewayProxy, false);
});

test('resolveProvider does not enable failover when provider is explicitly specified', () => {
  const env = {
    GATEWAY_CONFIG_JSON: JSON.stringify({
      defaultProvider: 'openai',
      providers: {
        openai: { apiKey: 'sk-openai', models: ['shared-model'] },
        pollinations: { apiKey: 'pollinations-key', models: ['shared-model'] },
      },
    }),
  };

  const resolved = resolveProvider({
    env,
    provider: 'openai',
    model: 'shared-model',
    random: () => 0,
  });

  assert.equal(resolved.failoverEnabled, false);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.provider), ['openai']);
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.model, 'shared-model');
});

test('resolveProvider randomizes same-model candidates into failover order when provider is omitted', () => {
  const env = {
    GATEWAY_CONFIG_JSON: JSON.stringify({
      defaultProvider: 'openai',
      providers: {
        openai: { apiKey: 'sk-openai', models: ['shared-model'] },
        pollinations: { apiKey: 'pollinations-key', models: ['shared-model'] },
      },
    }),
  };

  const resolved = resolveProvider({
    env,
    model: 'shared-model',
    random: () => 0,
  });

  assert.equal(resolved.failoverEnabled, true);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.provider), ['pollinations', 'openai']);
  assert.equal(resolved.primaryProvider, 'pollinations');
  assert.equal(resolved.provider, 'pollinations');
  assert.equal(resolved.languageModel?.provider, 'pollinations');
  assert.equal(resolved.languageModel?.modelId, 'shared-model');
});

test('resolveProvider keeps a single candidate when allowFailover is false', () => {
  const env = {
    GATEWAY_CONFIG_JSON: JSON.stringify({
      defaultProvider: 'openai',
      providers: {
        openai: { apiKey: 'sk-openai', models: ['shared-model'] },
        pollinations: { apiKey: 'pollinations-key', models: ['shared-model'] },
      },
    }),
  };

  const resolved = resolveProvider({
    env,
    model: 'shared-model',
    random: () => 0,
    allowFailover: false,
  });

  assert.equal(resolved.failoverEnabled, false);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.provider), ['openai']);
  assert.equal(resolved.provider, 'openai');
});

test('api resolve exposes sdk metadata', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'pollinations', model: 'openai' }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.provider, 'pollinations');
  assert.equal(data.sdkProvider, 'pollinations');
  assert.equal(data.supportsTextGeneration, true);
});

test('removed metadata api routes return 404', async () => {
  for (const path of ['/api', '/api/config', '/api/models', '/api/health']) {
    const response = await worker.fetch(new Request(`https://example.com${path}`), baseEnv);
    assert.equal(response.status, 404);
  }
});

test('static index page uses location.origin without frontend metadata loading', () => {
  assert.equal(indexHtml.includes('location.origin'), true);
  assert.equal(indexHtml.includes("fetch('/api/config')"), false);
  assert.equal(indexHtml.includes("fetch('/api/models')"), false);
  assert.equal(indexHtml.includes("fetch('/api/health')"), false);
  assert.equal(indexHtml.includes('should-not-be-rendered.example.com'), false);
  assert.equal(indexHtml.includes('gatewayBaseUrl'), false);
});

test('static index page renders simple request forms for api and proxy routes', () => {
  assert.equal(indexHtml.includes('id="generate-form"'), true);
  assert.equal(indexHtml.includes('id="stream-form"'), true);
  assert.equal(indexHtml.includes('id="chat-form"'), true);
  assert.equal(indexHtml.includes('发送到 /api/generate'), true);
  assert.equal(indexHtml.includes('发送到 /api/stream'), true);
  assert.equal(indexHtml.includes('发送到 /v1/chat/completions'), true);
  assert.equal(indexHtml.includes('/v1/chat/completions?provider='), true);
  assert.equal(indexHtml.includes("const defaults={provider:'openai',model:'gpt-4o-mini'"), true);
  assert.equal(indexHtml.includes('网关状态'), false);
  assert.equal(indexHtml.includes('公开配置'), false);
  assert.equal(indexHtml.includes('已暴露模型'), false);
});

test('v1 models returns local catalog', async () => {
  const response = await worker.fetch(new Request('https://example.com/v1/models'), baseEnv);

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'list');
  assert.ok(data.data.some((model) => model.id === 'gpt-4o-mini' && model.owned_by === 'openai'));
});

test('v1 chat completions proxies directly to upstream without local reformatting', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];
  const requestBody = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello gateway' }],
    stream: true,
  };

  globalThis.fetch = async (url, init = {}) => {
    upstreamCalls.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: init.body ? await new Response(init.body).text() : '',
    });

    return new Response(JSON.stringify({ id: 'chatcmpl-upstream' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-upstream': '1' },
    });
  };

  try {
    const response = await worker.fetch(
      new Request('https://example.com/v1/chat/completions?provider=openai', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer client-key',
        },
        body: JSON.stringify(requestBody),
      }),
      baseEnv,
    );

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(upstreamCalls[0].method, 'POST');
    assert.equal(upstreamCalls[0].headers.get('authorization'), 'Bearer sk-openai');
    assert.equal(upstreamCalls[0].headers.get('x-provider'), null);
    assert.equal(upstreamCalls[0].body, JSON.stringify(requestBody));
    assert.equal(response.headers.get('x-gateway-provider'), 'openai');
    assert.equal(response.headers.get('x-gateway-model'), 'gpt-4o-mini');

    const data = await response.json();
    assert.equal(data.id, 'chatcmpl-upstream');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildAiSdkRequest converts UI messages via convertToModelMessages and keeps declarative tools', async () => {
  const { call } = await buildApiCall({
    provider: 'openai',
    model: 'gpt-4o-mini',
    system: [{ content: 'You are helpful.' }],
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Look at this image.' },
          { type: 'file', url: 'https://example.com/cat.png', mediaType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        parts: [{ type: 'tool-lookupWeather', toolCallId: 'call_1', state: 'input-available', input: { city: 'Paris' } }],
      },
      {
        id: 'tool-result-msg',
        role: 'assistant',
        parts: [{ type: 'tool-lookupWeather', toolCallId: 'call_1', state: 'output-available', input: { city: 'Paris' }, output: { tempC: 21 } }],
      },
    ],
    tools: {
      lookupWeather: {
        description: 'Look up the weather for a city.',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { tempC: { type: 'number' } },
          required: ['tempC'],
          additionalProperties: false,
        },
        needsApproval: true,
        strict: true,
        inputExamples: [{ city: 'Paris' }],
      },
    },
    toolChoice: { type: 'tool', toolName: 'lookupWeather' },
    activeTools: ['lookupWeather'],
  });

  assert.equal(call.system[0].role, 'system');
  assert.equal(call.messages.length, 4);
  assert.equal(call.messages[0].role, 'user');
  assert.equal(call.messages[0].content[0].type, 'text');
  assert.equal(call.messages[0].content[1].type, 'file');
  assert.equal(call.messages[0].content[1].data, 'https://example.com/cat.png');
  assert.equal(call.messages[1].content[0].type, 'tool-call');
  assert.equal(call.messages[2].content[0].type, 'tool-call');
  assert.equal(call.messages[3].role, 'tool');
  assert.equal(call.messages[3].content[0].type, 'tool-result');
  assert.deepEqual(call.toolChoice, { type: 'tool', toolName: 'lookupWeather' });
  assert.deepEqual(call.activeTools, ['lookupWeather']);
  assert.equal(call.tools.lookupWeather.description, 'Look up the weather for a city.');
  assert.ok(call.tools.lookupWeather.inputSchema);
  assert.ok(call.tools.lookupWeather.outputSchema);
});

test('buildAiSdkRequest passes through model messages and sanitizes client headers', async () => {
  const { call } = await buildApiCall({
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    headers: {
      authorization: 'Bearer client-key',
      cookie: 'session=abc',
      'x-api-key': 'client-secret',
      'x-trace-id': 'trace-123',
    },
    timeout: { totalMs: 5000, chunkMs: 1000 },
    maxRetries: 2,
  });

  assert.deepEqual(call.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.deepEqual(call.headers, { 'x-trace-id': 'trace-123' });
  assert.deepEqual(call.timeout, { totalMs: 5000, chunkMs: 1000 });
  assert.equal(call.maxRetries, 2);
});

test('buildAiSdkRequest rejects mixing UI messages and model messages', async () => {
  await assert.rejects(
    () =>
      buildApiCall({
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    /must contain either UI messages with `parts` or ModelMessages with `content`, not a mix/,
  );
});

test('buildAiSdkRequest rejects legacy /api aliases', async () => {
  await assert.rejects(
    () => buildApiCall({ provider: 'openai', model: 'gpt-4o-mini', input: 'ping' }),
    /`input` is not supported on `\/api` routes\. Use AI SDK field `prompt` instead\./,
  );
});

test('buildAiSdkRequest rejects non-JSON AI SDK runtime options', async () => {
  await assert.rejects(
    () => buildApiCall({ provider: 'openai', model: 'gpt-4o-mini', prompt: 'ping', output: { type: 'object' } }),
    /`output` is not supported on `\/api` routes because it requires non-JSON runtime behavior\./,
  );
});

test('api stream returns an event stream for AI SDK routes', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();

  globalThis.fetch = async () => {
    const chunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };

  try {
    const response = await worker.fetch(
      new Request('https://example.com/api/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', prompt: 'ping' }),
      }),
      baseEnv,
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/i);
    assert.equal(response.headers.get('x-gateway-provider'), 'openai');
    assert.equal(response.headers.get('x-gateway-model'), 'gpt-4o-mini');

    const body = await response.text();
    assert.match(body, /data:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api generate validates missing prompt or messages', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /prompt|messages/i);
});

test('missing GATEWAY_CONFIG_JSON returns a clear error', () => {
  assert.throws(
    () => resolveProvider({ env: {} }),
    /Missing `GATEWAY_CONFIG_JSON`/,
  );
});