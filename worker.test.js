import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { createModelFromProvider, getProviders, resolveProvider } from './worker.js';

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

test('api config does not expose gatewayBaseUrl even if present in input config', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/api/config'),
    {
      GATEWAY_CONFIG_JSON: JSON.stringify({
        ...baseConfig,
        gatewayBaseUrl: 'https://should-not-be-exposed.example.com',
      }),
    },
  );

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal('gatewayBaseUrl' in data, false);
  assert.equal(data.defaultProvider, 'openai');
});

test('index page uses location.origin for the displayed gateway URL', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/'),
    {
      GATEWAY_CONFIG_JSON: JSON.stringify({
        ...baseConfig,
        gatewayBaseUrl: 'https://should-not-be-rendered.example.com',
      }),
    },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(html.includes('location.origin'), true);
  assert.equal(html.includes('__GATEWAY_ORIGIN__/api/generate'), true);
  assert.equal(html.includes('should-not-be-rendered.example.com'), false);
  assert.equal(html.includes('gatewayBaseUrl'), false);
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