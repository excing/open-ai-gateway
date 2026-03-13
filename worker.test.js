import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker, { buildAiSdkRequest } from './worker.js';

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
      models: [{ code: 'gpt-4o-mini' }, { code: 'gpt-4.1-mini' }],
      headers: {},
    },
    {
      name: 'Groq GPT-4o Mini',
      key: 'groq-gpt4o-mini',
      provider: 'groq',
      apiKey: 'groq-key',
      baseURL: 'https://api.groq.com/openai/v1',
      models: [{ code: 'gpt-4o-mini' }],
      headers: { 'x-channel-source': 'groq' },
    },
    {
      name: 'Google Gemini',
      key: 'google-gemini',
      provider: 'google',
      apiKey: 'google-key',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      models: [{ code: 'gemini-2.5-flash' }],
      headers: {},
    },
    {
      name: 'Anthropic Claude',
      key: 'anthropic-claude',
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      baseURL: 'https://api.anthropic.com/v1',
      models: [{ code: 'claude-3-5-sonnet-latest' }],
      headers: {},
    },
    {
      name: 'OpenRouter',
      key: 'openrouter',
      provider: 'openrouter',
      apiKey: 'openrouter-key',
      baseURL: 'https://openrouter.ai/api/v1',
      models: [{ code: 'openai/gpt-4o-mini' }],
      headers: {},
    },
    {
      name: 'Pollinations',
      key: 'pollinations',
      provider: 'pollinations',
      apiKey: 'pollinations-key',
      baseURL: 'https://text.pollinations.ai/openai',
      models: [{ code: 'openai' }],
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

function buildApiCall(body) {
  return buildAiSdkRequest(body);
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

test('buildAiSdkRequest ignores incoming provider, channel, and model routing fields', async () => {
  const call = await buildApiCall({
    provider: 'anthropic',
    channel: 'does-not-matter',
    model: 'gpt-4o-mini',
    prompt: 'ping',
  });

  assert.equal(call.prompt, 'ping');
  assert.equal('provider' in call, false);
  assert.equal('channel' in call, false);
  assert.equal('model' in call, false);
});

test('api generate normalizes alias matches to canonical upstream model code', async () => {
  const env = envWithConfig({
    channels: [
      {
        name: 'Aliased OpenAI',
        key: 'aliased-openai',
        provider: 'openai',
        apiKey: 'sk-openai',
        baseURL: 'https://api.openai.com/v1',
        models: [{ code: 'gpt-4o-mini', aliases: ['openai-gpt-4o-mini'] }],
        headers: {},
      },
    ],
  });

  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    upstreamCalls.push({
      url: String(url),
      body: init.body ? await new Response(init.body).text() : '',
    });

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-alias-1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const response = await worker.fetch(
      authedRequest('https://example.com/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'openai-gpt-4o-mini', prompt: 'ping' }),
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, 'https://api.openai.com/v1/chat/completions');
    const upstreamBody = JSON.parse(upstreamCalls[0].body);
    assert.equal(upstreamBody.model, 'gpt-4o-mini');
    assert.equal(upstreamBody.messages[0]?.content, 'ping');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('removed metadata api routes return 404', async () => {
  for (const path of ['/api', '/api/config', '/api/models', '/api/health', '/api/resolve']) {
    const response = await worker.fetch(
      authedRequest(`https://example.com${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      baseEnv,
    );
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

test('static index page renders model-only request forms for current api routes', () => {
  assert.equal(indexHtml.includes('id="generate-form"'), true);
  assert.equal(indexHtml.includes('id="stream-form"'), true);
  assert.equal(indexHtml.includes('id="chat-form"'), false);
  assert.equal(indexHtml.includes('id="chat-stream"'), false);
  assert.equal(indexHtml.includes('发送到 /api/generate'), true);
  assert.equal(indexHtml.includes('发送到 /api/stream'), true);
  assert.equal(indexHtml.includes('发送到 /v1/chat/completions'), false);
  assert.equal(indexHtml.includes('generate-provider'), false);
  assert.equal(indexHtml.includes('stream-provider'), false);
  assert.equal(indexHtml.includes('chat-provider'), false);
  assert.equal(indexHtml.includes('/v1/chat/completions?provider='), false);
  assert.equal(indexHtml.includes("const defaults={model:'moonshotai/kimi-k2-instruct-0905'};"), true);
  assert.equal(indexHtml.includes('由后端决定走哪条 channel'), true);
  assert.equal(indexHtml.includes('/v1/models'), true);
  assert.equal(indexHtml.includes('OpenAI Chat Completions 透明代理（支持流式开关）'), false);
  assert.equal(indexHtml.includes('流式响应（stream）'), false);
  assert.equal(indexHtml.includes('开启后按 SSE 增量预览；关闭后展示最终 JSON 响应。'), false);
  assert.equal(indexHtml.includes('const stream = isChatStreamEnabled();'), false);
  assert.equal(indexHtml.includes('proxyModel'), false);
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

test('v1 models returns canonical codes without exposing aliases as separate models', async () => {
  const env = envWithConfig({
    channels: [
      {
        name: 'Groq Alias',
        key: 'groq-alias',
        provider: 'groq',
        apiKey: 'groq-key',
        baseURL: 'https://api.groq.com/openai/v1',
        models: [{ code: 'gpt-4o-mini', aliases: ['openai-gpt-4o-mini'] }],
        headers: {},
      },
      {
        name: 'OpenAI Alias',
        key: 'openai-alias',
        provider: 'openai',
        apiKey: 'sk-openai',
        baseURL: 'https://api.openai.com/v1',
        models: [
          { code: 'GPT-4O-MINI', aliases: ['OPENAI-GPT-4O-MINI'] },
          { code: 'gpt-4.1-mini', aliases: ['openai-gpt-4.1-mini'] },
        ],
        headers: {},
      },
    ],
  });

  const response = await worker.fetch(authedRequest('https://example.com/v1/models'), env);

  assert.equal(response.status, 200);
  const data = await response.json();
  const ids = data.data.map((model) => model.id).sort();
  assert.deepEqual(ids, ['gpt-4.1-mini', 'gpt-4o-mini']);
  assert.equal(ids.includes('openai-gpt-4o-mini'), false);
});

test('v1 routes other than models return 404', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello gateway' }] }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 404);
  const data = await response.json();
  assert.match(data?.error?.message || '', /Unsupported API route: \/v1\/chat\/completions/);
});

test('buildAiSdkRequest converts UI messages via convertToModelMessages and keeps declarative tools', async () => {
  const call = await buildApiCall({
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

  const messages = await call.messages;

  assert.deepEqual(call.system, [{ content: 'You are helpful.' }]);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content[0].type, 'text');
  assert.equal(messages[0].content[1].type, 'file');
  assert.equal(messages[0].content[1].data, 'https://example.com/cat.png');
  assert.equal(messages[1].content[0].type, 'tool-call');
  assert.equal(messages[2].content[0].type, 'tool-call');
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].content[0].type, 'tool-result');
  assert.deepEqual(call.toolChoice, { type: 'tool', toolName: 'lookupWeather' });
  assert.deepEqual(call.activeTools, ['lookupWeather']);
  assert.equal(call.tools.lookupWeather.description, 'Look up the weather for a city.');
  assert.ok(call.tools.lookupWeather.inputSchema);
  assert.ok(call.tools.lookupWeather.outputSchema);
});

test('buildAiSdkRequest sanitizes client headers and normalizes timeout', async () => {
  const call = await buildApiCall({
    prompt: 'ping',
    headers: {
      authorization: 'Bearer client-key',
      cookie: 'session=abc',
      'x-api-key': 'client-secret',
      'x-trace-id': 'trace-123',
    },
    timeout: { totalMs: 5000, chunkMs: 1000 },
    maxRetries: 2,
  });

  assert.equal(call.prompt, 'ping');
  assert.deepEqual(call.headers, { 'x-trace-id': 'trace-123' });
  assert.deepEqual(call.timeout, { totalMs: 5000, chunkMs: 1000 });
  assert.equal(call.maxRetries, 2);
});

test('buildAiSdkRequest includes non-chat parameters for other call types', async () => {
  const structuredPrompt = { image: 'data:image/png;base64,AAAA', text: 'animate this' };
  const call = await buildApiCall({
    prompt: structuredPrompt,
    n: '2',
    maxImagesPerCall: '3',
    size: '1024x1024',
    aspectRatio: '16:9',
    maxVideosPerCall: '4',
    resolution: '1280x720',
    duration: '5',
    fps: '24',
    text: 'hello world',
    voice: 'alloy',
    outputFormat: 'mp3',
    instructions: 'Speak slowly',
    speed: '1.25',
    language: 'en',
    values: ['hello', 42],
    maxParallelCalls: '8',
    audio: 'https://example.com/audio.mp3',
  });

  assert.deepEqual(call.prompt, structuredPrompt);
  assert.equal(call.n, 2);
  assert.equal(call.maxImagesPerCall, 3);
  assert.equal(call.size, '1024x1024');
  assert.equal(call.aspectRatio, '16:9');
  assert.equal(call.maxVideosPerCall, 4);
  assert.equal(call.resolution, '1280x720');
  assert.equal(call.duration, 5);
  assert.equal(call.fps, 24);
  assert.equal(call.text, 'hello world');
  assert.equal(call.voice, 'alloy');
  assert.equal(call.outputFormat, 'mp3');
  assert.equal(call.instructions, 'Speak slowly');
  assert.equal(call.speed, 1.25);
  assert.equal(call.language, 'en');
  assert.deepEqual(call.values, ['hello', '42']);
  assert.equal(call.maxParallelCalls, 8);
  assert.equal(String(call.audio), 'https://example.com/audio.mp3');
});

test('buildAiSdkRequest normalizes snake_case aliases for non-chat and shared options', async () => {
  const call = await buildApiCall({
    prompt: 'ping',
    tool_choice: 'auto',
    active_tools: ['lookupWeather'],
    provider_options: { openai: { parallelToolCalls: false } },
    stop_sequences: ['DONE'],
    max_images_per_call: '3',
    aspect_ratio: '16:9',
    max_videos_per_call: '4',
    output_format: 'mp3',
    max_parallel_calls: '8',
    max_retries: '2',
  });

  assert.equal(call.toolChoice, 'auto');
  assert.deepEqual(call.activeTools, ['lookupWeather']);
  assert.deepEqual(call.providerOptions, { openai: { parallelToolCalls: false } });
  assert.deepEqual(call.stopSequences, ['DONE']);
  assert.equal(call.maxImagesPerCall, 3);
  assert.equal(call.aspectRatio, '16:9');
  assert.equal(call.maxVideosPerCall, 4);
  assert.equal(call.outputFormat, 'mp3');
  assert.equal(call.maxParallelCalls, 8);
  assert.equal(call.maxRetries, 2);
});

test('buildAiSdkRequest surfaces conversion errors for non-UI messages', async () => {
  const call = await buildApiCall({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  });

  await assert.rejects(() => call.messages, /Cannot read properties of undefined/);
});

test('buildAiSdkRequest accepts legacy /api aliases and normalizes them', async () => {
  const call = await buildApiCall({
    model: 'gpt-4o-mini',
    input: 'ping',
    top_p: '0.5',
    top_k: '20',
    max_tokens: '128',
    presence_penalty: '0.1',
    frequency_penalty: '0.2',
    stop: ['DONE'],
  });

  assert.equal(call.prompt, 'ping');
  assert.equal(call.topP, 0.5);
  assert.equal(call.topK, 20);
  assert.equal(call.maxOutputTokens, 128);
  assert.equal(call.presencePenalty, 0.1);
  assert.equal(call.frequencyPenalty, 0.2);
  assert.deepEqual(call.stopSequences, ['DONE']);
});

test('buildAiSdkRequest prefers canonical AI SDK fields over legacy aliases', async () => {
  const call = await buildApiCall({
    model: 'gpt-4o-mini',
    prompt: 'canonical',
    input: 'legacy',
    topP: 0.9,
    top_p: 0.5,
    maxOutputTokens: 256,
    max_tokens: 128,
  });

  assert.equal(call.prompt, 'canonical');
  assert.equal(call.topP, 0.9);
  assert.equal(call.maxOutputTokens, 256);
});

test('api routes reject non-JSON AI SDK runtime options', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await worker.fetch(
      authedRequest('https://example.com/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', prompt: 'ping', output: { type: 'object' } }),
      }),
      baseEnv,
    );

    assert.equal(response.status, 500);
    const data = await response.json();
    assert.match(data.error.message, /`output` is not supported on `\/api` routes because it requires non-JSON runtime behavior\./);
  } finally {
    console.error = originalConsoleError;
  }
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
      assert.equal(response.headers.get('x-gateway-provider'), 'groq');
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
      assert.equal(upstreamCalls.length, 1);
      assert.equal(upstreamCalls[0].url, 'https://api.groq.com/openai/v1/chat/completions');

      const data = await response.json();
      assert.equal(Array.isArray(data.steps), true);
      assert.equal(data.steps[0]?.content[0]?.type, 'text');
      assert.equal(data.steps[0]?.content[0]?.text, 'pong');
      assert.equal(data.steps[0]?.finishReason, 'stop');
      assert.equal(data._output, 'pong');
      assert.equal(data.totalUsage.inputTokens, 1);
      assert.equal(data.totalUsage.outputTokens, 1);
      assert.equal(data.totalUsage.totalTokens, 2);
      assert.equal(data.totalUsage.reasoningTokens, 0);
      assert.equal(data.totalUsage.cachedInputTokens, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api generate fails over when the first channel returns 404', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    upstreamCalls.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: init.body ? await new Response(init.body).text() : '',
    });

    if (String(url) === 'https://api.groq.com/openai/v1/chat/completions') {
      return new Response(JSON.stringify({ error: { message: 'model not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-generate-failover-1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'fallback pong' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
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
      assert.equal(upstreamCalls.length, 2);
      assert.equal(upstreamCalls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(upstreamCalls[1].url, 'https://api.openai.com/v1/chat/completions');

      const data = await response.json();
      assert.equal(data.steps[0]?.content[0]?.text, 'fallback pong');
      assert.equal(data._output, 'fallback pong');
      assert.equal(data.totalUsage.inputTokens, 1);
      assert.equal(data.totalUsage.outputTokens, 2);
      assert.equal(data.totalUsage.totalTokens, 3);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api generate returns 500 when all chat candidates fail prompt validation', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini' }),
    }),
    baseEnv,
  );

  assert.equal(response.status, 500);
  const data = await response.json();
  assert.match(data.error.message, /Failed for model/);
});

test('missing GATEWAY_CONFIG_JSON returns a clear error', async () => {
  const response = await worker.fetch(
    authedRequest('https://example.com/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', prompt: 'ping' }),
    }),
    { ADMIN_KEY: adminKey },
  );

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /Missing `GATEWAY_CONFIG_JSON`/);
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