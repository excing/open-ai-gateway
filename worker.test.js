import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker, { buildAiSdkRequest, createModelFromChannel, getChannels, resolveModel } from './worker.js';

const indexHtml = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

const adminKey = 'gateway-admin-key';

const baseConfig = {
  channels: [
    {
      name: 'OpenAI Main',
      key: 'openai-main',
      provider: 'openai',
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini', 'gpt-4.1-mini'],
      headers: {},
    },
    {
      name: 'Groq GPT-4o Mini',
      key: 'groq-gpt4o-mini',
      provider: 'groq',
      apiKey: 'groq-key',
      baseURL: 'https://api.groq.com/openai/v1',
      models: ['gpt-4o-mini'],
      headers: { 'x-channel-source': 'groq' },
    },
    {
      name: 'Google Gemini',
      key: 'google-gemini',
      provider: 'google',
      apiKey: 'google-key',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      models: ['gemini-2.5-flash'],
      headers: {},
    },
    {
      name: 'Anthropic Claude',
      key: 'anthropic-claude',
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      baseURL: 'https://api.anthropic.com/v1',
      models: ['claude-3-5-sonnet-latest'],
      headers: {},
    },
    {
      name: 'OpenRouter',
      key: 'openrouter',
      provider: 'openrouter',
      apiKey: 'openrouter-key',
      baseURL: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-4o-mini'],
      headers: {},
    },
    {
      name: 'Pollinations',
      key: 'pollinations',
      provider: 'pollinations',
      apiKey: 'pollinations-key',
      baseURL: 'https://text.pollinations.ai/openai',
      models: ['openai'],
      headers: {},
    },
  ],
};

const baseEnv = {
  ADMIN_KEY: adminKey,
  GATEWAY_CONFIG_JSON: JSON.stringify(baseConfig),
};

function envWithConfig(config) {
  return {
    ADMIN_KEY: adminKey,
    GATEWAY_CONFIG_JSON: JSON.stringify(config),
  };
}

function withAdminHeaders(headers = {}) {
  return {
    'x-admin-key': adminKey,
    ...headers,
  };
}

function authedRequest(url, init = {}) {
  return new Request(url, {
    ...init,
    headers: withAdminHeaders(init.headers || {}),
  });
}

function buildApiCall(body, { env = baseEnv, url = 'https://example.com/api/generate' } = {}) {
  return buildAiSdkRequest({
    body,
    env,
    url: new URL(url),
  });
}

async function withMockedRandom(randomValue, callback) {
  const originalRandom = Math.random;
  Math.random = () => randomValue;

  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

test('getChannels returns configured channels', () => {
  const channels = getChannels(baseEnv);

  assert.deepEqual(channels.map((channel) => channel.key), [
    'openai-main',
    'groq-gpt4o-mini',
    'google-gemini',
    'anthropic-claude',
    'openrouter',
    'pollinations',
  ]);
  assert.equal('compatibility' in channels[4], false);
  assert.equal('referrer' in channels[5], false);
});

test('createModelFromChannel returns a language model instance', () => {
  const resolved = createModelFromChannel('openai-main', 'gpt-4o-mini', baseEnv);

  assert.equal(resolved.channel, 'openai-main');
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.kind, 'openai');
  assert.equal(resolved.model, 'gpt-4o-mini');
  assert.equal(typeof resolved.languageModel?.doGenerate, 'function');
});

test('resolveModel randomizes same-model channels into failover order', () => {
  const resolved = resolveModel({
    env: baseEnv,
    model: 'gpt-4o-mini',
    random: () => 0,
  });

  assert.equal(resolved.failoverEnabled, true);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.channel), ['groq-gpt4o-mini', 'openai-main']);
  assert.equal(resolved.primaryChannel, 'groq-gpt4o-mini');
  assert.equal(resolved.channel, 'groq-gpt4o-mini');
  assert.equal(resolved.languageModel?.provider, 'groq-gpt4o-mini');
  assert.equal(resolved.languageModel?.modelId, 'gpt-4o-mini');
});

test('resolveModel keeps a single candidate when allowFailover is false', () => {
  const resolved = resolveModel({
    env: baseEnv,
    model: 'gpt-4o-mini',
    random: () => 0,
    allowFailover: false,
  });

  assert.equal(resolved.failoverEnabled, false);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.channel), ['groq-gpt4o-mini']);
  assert.equal(resolved.channel, 'groq-gpt4o-mini');
});

test('resolveModel matches model names case-insensitively across channels', () => {
  const env = envWithConfig({
    channels: [
      {
        name: 'Model Lower',
        key: 'model-lower',
        provider: 'openai',
        apiKey: 'sk-lower',
        baseURL: 'https://api.openai.com/v1',
        models: ['gpt-4o-mini'],
        headers: {},
      },
      {
        name: 'Model Upper',
        key: 'model-upper',
        provider: 'openai',
        apiKey: 'sk-upper',
        baseURL: 'https://api.openai.com/v1',
        models: ['GPT-4O-MINI'],
        headers: {},
      },
      {
        name: 'Model Mixed',
        key: 'model-mixed',
        provider: 'openai',
        apiKey: 'sk-mixed',
        baseURL: 'https://api.openai.com/v1',
        models: ['GpT-4O-MiNi'],
        headers: {},
      },
      {
        name: 'Other Model',
        key: 'other-model',
        provider: 'openai',
        apiKey: 'sk-other',
        baseURL: 'https://api.openai.com/v1',
        models: ['gpt-4.1-mini'],
        headers: {},
      },
    ],
  });

  const resolved = resolveModel({
    env,
    model: 'gPt-4o-MiNi',
    random: () => 0,
  });

  assert.equal(resolved.candidates.length, 3);
  assert.deepEqual(
    resolved.candidates.map((candidate) => candidate.channel).sort(),
    ['model-lower', 'model-mixed', 'model-upper'],
  );
  assert.equal(resolved.model, 'gPt-4o-MiNi');
});

test('resolveModel requires model', () => {
  assert.throws(() => resolveModel({ env: baseEnv }), /`model` is required\./);
});

test('buildAiSdkRequest ignores incoming provider and channel', async () => {
  const env = envWithConfig({
    channels: [
      {
        name: 'Only OpenAI',
        key: 'only-openai',
        provider: 'openai',
        apiKey: 'sk-openai',
        baseURL: 'https://api.openai.com/v1',
        models: ['gpt-4o-mini'],
        headers: {},
      },
    ],
  });

  const { resolved } = await buildApiCall(
    {
      provider: 'anthropic',
      channel: 'does-not-matter',
      model: 'gpt-4o-mini',
      prompt: 'ping',
    },
    { env },
  );

  assert.equal(resolved.channel, 'only-openai');
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.model, 'gpt-4o-mini');
});

test('api resolve exposes channel metadata', async () => {
  await withMockedRandom(0, async () => {
    const response = await worker.fetch(
      authedRequest('https://example.com/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'ignored', channel: 'ignored', model: 'gpt-4o-mini' }),
      }),
      baseEnv,
    );

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.channel, 'groq-gpt4o-mini');
    assert.equal(data.channelName, 'Groq GPT-4o Mini');
    assert.equal(data.provider, 'openai-compatible');
    assert.equal(data.sdkProvider, 'openai-compatible');
    assert.equal(data.supportsTextGeneration, true);
    assert.equal(data.failoverEnabled, true);
    assert.deepEqual(
      data.candidates.map((candidate) => candidate.channel),
      ['groq-gpt4o-mini', 'openai-main'],
    );
  });
});

test('removed metadata api routes return 404', async () => {
  for (const path of ['/api', '/api/config', '/api/models', '/api/health']) {
    const response = await worker.fetch(authedRequest(`https://example.com${path}`), baseEnv);
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

test('static index page renders model-only request forms for api and proxy routes', () => {
  assert.equal(indexHtml.includes('id="generate-form"'), true);
  assert.equal(indexHtml.includes('id="stream-form"'), true);
  assert.equal(indexHtml.includes('id="chat-form"'), true);
  assert.equal(indexHtml.includes('发送到 /api/generate'), true);
  assert.equal(indexHtml.includes('发送到 /api/stream'), true);
  assert.equal(indexHtml.includes('发送到 /v1/chat/completions'), true);
  assert.equal(indexHtml.includes('generate-provider'), false);
  assert.equal(indexHtml.includes('stream-provider'), false);
  assert.equal(indexHtml.includes('chat-provider'), false);
  assert.equal(indexHtml.includes('/v1/chat/completions?provider='), false);
  assert.equal(indexHtml.includes("const defaults={model:'moonshotai/kimi-k2-instruct-0905',proxyModel:'moonshotai/kimi-k2-instruct-0905'};"), true);
  assert.equal(indexHtml.includes('由后端决定走哪条 channel'), true);
  assert.equal(indexHtml.includes('OpenAI Chat Completions 流式透明代理'), true);
  assert.equal(indexHtml.includes('右侧会按流式增量做打字机预览。'), true);
  assert.equal(indexHtml.includes("payload: { model: value('chat-model', defaults.proxyModel), messages: [{ role: 'user', content: value('chat-prompt', '你好，请按 OpenAI Chat Completions 风格回复一句话，并给出一句建议。') }], stream: true }"), true);
  assert.equal(indexHtml.includes('网关状态'), false);
  assert.equal(indexHtml.includes('公开配置'), false);
  assert.equal(indexHtml.includes('已暴露模型'), false);
});

test('static index page includes admin key input and auth header usage', () => {
  assert.equal(indexHtml.includes('id="admin-key"'), true);
  assert.equal(indexHtml.includes('Admin Key'), true);
  assert.equal(indexHtml.includes('x-admin-key'), true);
  assert.equal(indexHtml.includes('replace-with-admin-key'), true);
});

test('static index page includes typewriter-friendly stream preview logic', () => {
  assert.equal(indexHtml.includes('.preview-body.typing::after'), true);
  assert.equal(indexHtml.includes("payload?.type === 'text-delta'"), true);
  assert.equal(indexHtml.includes("payload?.type === 'reasoning-delta'"), true);
  assert.equal(indexHtml.includes("payload?.type === 'tool-input-start'"), true);
  assert.equal(indexHtml.includes("payload?.type === 'source-url'"), true);
  assert.equal(indexHtml.includes("payload?.type === 'file'"), true);
  assert.equal(indexHtml.includes('正在等待模型开始输出'), true);
  assert.equal(indexHtml.includes('附加事件：'), true);
});

test('protected routes require admin auth', async () => {
  const requests = [
    new Request('https://example.com/healthz'),
    new Request('https://example.com/v1/models'),
    new Request('https://example.com/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', prompt: 'ping' }),
    }),
  ];

  for (const request of requests) {
    const response = await worker.fetch(request, baseEnv);
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.match(data.error.message, /Unauthorized/i);
  }
});

test('protected routes accept bearer admin auth', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/healthz', {
      headers: { authorization: `Bearer ${adminKey}` },
    }),
    baseEnv,
  );

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.channelCount, 6);
});

test('v1 models returns deduped logical catalog', async () => {
  const response = await worker.fetch(authedRequest('https://example.com/v1/models'), baseEnv);

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'list');
  assert.ok(data.data.some((model) => model.id === 'gpt-4o-mini' && model.owned_by === 'gateway'));
  assert.equal(data.data.filter((model) => model.id === 'gpt-4o-mini').length, 1);
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
    await withMockedRandom(0, async () => {
      const response = await worker.fetch(
        authedRequest('https://example.com/v1/chat/completions?provider=ignored&channel=ignored', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer client-key',
            'x-provider': 'ignored',
            'x-channel': 'ignored',
          },
          body: JSON.stringify(requestBody),
        }),
        baseEnv,
      );

      assert.equal(response.status, 200);
      assert.equal(upstreamCalls.length, 1);
      assert.equal(upstreamCalls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(upstreamCalls[0].method, 'POST');
      assert.equal(upstreamCalls[0].headers.get('authorization'), 'Bearer groq-key');
      assert.equal(upstreamCalls[0].headers.get('x-provider'), null);
      assert.equal(upstreamCalls[0].headers.get('x-channel'), null);
      assert.equal(upstreamCalls[0].headers.get('x-admin-key'), null);
      assert.equal(upstreamCalls[0].body, JSON.stringify(requestBody));
      assert.equal(response.headers.get('x-gateway-channel'), 'groq-gpt4o-mini');
      assert.equal(response.headers.get('x-gateway-provider'), 'openai-compatible');
      assert.equal(response.headers.get('x-gateway-model'), 'gpt-4o-mini');

      const data = await response.json();
      assert.equal(data.id, 'chatcmpl-upstream');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildAiSdkRequest converts UI messages via convertToModelMessages and keeps declarative tools', async () => {
  const { call } = await buildApiCall({
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
    () => buildApiCall({ model: 'gpt-4o-mini', input: 'ping' }),
    /`input` is not supported on `\/api` routes\. Use AI SDK field `prompt` instead\./,
  );
});

test('buildAiSdkRequest rejects non-JSON AI SDK runtime options', async () => {
  await assert.rejects(
    () => buildApiCall({ model: 'gpt-4o-mini', prompt: 'ping', output: { type: 'object' } }),
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
    await withMockedRandom(0, async () => {
      const response = await worker.fetch(
        authedRequest('https://example.com/api/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', prompt: 'ping' }),
        }),
        baseEnv,
      );

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/i);
      assert.equal(response.headers.get('x-gateway-channel'), 'groq-gpt4o-mini');
      assert.equal(response.headers.get('x-gateway-provider'), 'openai-compatible');
      assert.equal(response.headers.get('x-gateway-model'), 'gpt-4o-mini');

      const body = await response.text();
      assert.match(body, /data:/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api generate returns stable json for successful text generation', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    upstreamCalls.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: init.body ? await new Response(init.body).text() : '',
    });

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-generate-1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  try {
    await withMockedRandom(0, async () => {
      const response = await worker.fetch(
        authedRequest('https://example.com/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', prompt: 'ping' }),
        }),
        baseEnv,
      );

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /application\/json/i);
      assert.equal(response.headers.get('x-gateway-channel'), 'groq-gpt4o-mini');
      assert.equal(response.headers.get('x-gateway-provider'), 'openai-compatible');
      assert.equal(response.headers.get('x-gateway-model'), 'gpt-4o-mini');
      assert.equal(upstreamCalls.length, 1);
      assert.equal(upstreamCalls[0].url, 'https://api.groq.com/openai/v1/chat/completions');

      const data = await response.json();
      assert.deepEqual(Object.keys(data).sort(), ['content', 'finishReason', 'usage']);
      assert.equal(Array.isArray(data.content), true);
      assert.equal(data.content[0]?.type, 'text');
      assert.equal(data.content[0]?.text, 'pong');
      assert.equal(data.finishReason, 'stop');
      assert.equal(data.usage.inputTokens, 1);
      assert.equal(data.usage.outputTokens, 1);
      assert.equal(data.usage.totalTokens, 2);
      assert.equal(data.usage.reasoningTokens, 0);
      assert.equal(data.usage.cachedInputTokens, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api generate validates missing prompt or messages', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini' }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /prompt|messages/i);
});

test('missing GATEWAY_CONFIG_JSON returns a clear error', () => {
  assert.throws(() => resolveModel({ env: {} }), /Missing `GATEWAY_CONFIG_JSON`/);
});

test('missing ADMIN_KEY returns a clear error on protected routes', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await worker.fetch(
      new Request('https://example.com/healthz', {
        headers: { authorization: `Bearer ${adminKey}` },
      }),
      {
        GATEWAY_CONFIG_JSON: JSON.stringify(baseConfig),
      },
    );

    assert.equal(response.status, 500);
    const data = await response.json();
    assert.match(data.error.message, /Missing `ADMIN_KEY`/);
  } finally {
    console.error = originalConsoleError;
  }
});