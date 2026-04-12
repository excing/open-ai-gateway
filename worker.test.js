import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  CONSTANTS,
  SCHEMAS,
  createApp,
  createMemoryDb,
  makeTestEnv,
} from './worker.js';

const {
  CALL_TYPES,
  CALL_TYPE_TO_PATH,
  PATH_TO_CALL_TYPE,
  MODEL_STATUS,
  ERROR_MESSAGES,
  HTTP_STATUS,
  ROUTES,
  METHODS,
} = CONSTANTS;

const { CreateChannelSchema, UpdateChannelSchema, UpdateModelSchema, PaginationSchema, LogQuerySchema } = SCHEMAS;

function makeJsonRequest({ method, url, body, headers = {} }) {
  return new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function createStubProviders() {
  const makeProvider = (providerName) => ({
    chat: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.CHAT }),
    image: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.IMAGE_GEN }),
    video: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.VIDEO_GEN }),
    speech: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.AUDIO_GEN }),
    transcription: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.TRANSCRIBE }),
    embedding: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.EMBEDDING }),
    imageModel: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.IMAGE_GEN }),
    textEmbeddingModel: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.EMBEDDING }),
    embeddingModel: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.EMBEDDING }),
    speechModel: (modelId) => ({ modelId, provider: providerName, type: CALL_TYPES.AUDIO_GEN }),
  });

  return {
    createOpenAI: ({ name }) => makeProvider(`openai:${name}`),
    createGoogleGenerativeAI: ({ name }) => makeProvider(`google:${name}`),
    createAnthropic: ({ name }) => makeProvider(`anthropic:${name}`),
    createOpenRouter: ({ name }) => makeProvider(`openrouter:${name}`),
    createPollinations: ({ name }) => makeProvider(`pollinations:${name}`),
  };
}

function createStubAi() {
  const generateText = async ({ model, messages }) => {
    if (model.modelId === 'fail-model') {
      throw new Error('upstream failed');
    }
    return {
      text: `ok:${messages?.length ?? 0}`,
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      response: { id: 'resp-1' },
    };
  };

  const streamText = async ({ model, onFinish }) => {
    if (model.modelId === 'fail-stream-model') {
      throw new Error('stream failed');
    }
    const chunks = ['hello', ' world'];
    const textStream = (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();

    const finishEvent = {
      text: 'hello world',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    };
    if (onFinish) {
      await onFinish(finishEvent);
    }
    return { textStream };
  };

  const generateImage = async ({ model, prompt, n }) => {
    if (model.modelId === 'fail-image') {
      throw new Error('image failed');
    }
    const count = n ?? 1;
    return {
      images: Array.from({ length: count }, (_, index) => ({
        base64: `image-${prompt}-${index}`,
        mediaType: 'image/png',
      })),
    };
  };

  const experimental_generateVideo = async ({ model, prompt }) => {
    if (model.modelId === 'fail-video') {
      throw new Error('video failed');
    }
    return {
      videos: [{ base64: `video-${prompt}`, mediaType: 'video/mp4' }],
      video: { base64: `video-${prompt}`, mediaType: 'video/mp4' },
    };
  };

  const experimental_generateSpeech = async ({ model, text }) => {
    if (model.modelId === 'fail-speech') {
      throw new Error('speech failed');
    }
    return {
      audio: { data: new TextEncoder().encode(`audio-${text}`), mediaType: 'audio/mpeg' },
    };
  };

  const experimental_transcribe = async ({ model, audio }) => {
    if (model.modelId === 'fail-transcribe') {
      throw new Error('transcribe failed');
    }
    return { text: `transcribed-${audio?.name ?? 'file'}` };
  };

  const embed = async ({ model, value }) => {
    if (model.modelId === 'fail-embed') {
      throw new Error('embed failed');
    }
    return {
      embedding: [0.1, 0.2, 0.3],
      usage: { promptTokens: 5, totalTokens: 5 },
    };
  };

  return {
    generateText,
    streamText,
    generateImage,
    experimental_generateVideo,
    experimental_generateSpeech,
    experimental_transcribe,
    embed,
  };
}

function createAppForTest(seed = {}) {
  const db = createMemoryDb(seed);
  const env = makeTestEnv({ db });
  const providers = createStubProviders();
  const ai = createStubAi();
  const fallbackCalls = [];
  const createFallback = ({ models, onError }) => {
    fallbackCalls.push({ models, onError });
    return models[0];
  };

  const app = createApp({
    providers,
    ai,
    createFallback,
    now: () => new Date('2026-04-08T00:00:00.000Z'),
    uuid: () => 'uuid-fixed',
  });

  return { app, env, db, fallbackCalls };
}

test('constants mapping and schemas', () => {
  assert.equal(PATH_TO_CALL_TYPE[CALL_TYPE_TO_PATH[CALL_TYPES.CHAT]], CALL_TYPES.CHAT);
  assert.equal(MODEL_STATUS.ACTIVE, 'active');

  const channelParsed = CreateChannelSchema.parse({
    name: 'OpenAI',
    key: 'openai-main',
    provider: 'openai',
    apiKey: 'sk-test',
    baseURL: '',
    models: [],
  });
  assert.equal(channelParsed.name, 'OpenAI');

  assert.throws(() => CreateChannelSchema.parse({ name: '' }));
  assert.ok(UpdateChannelSchema.parse({ name: 'New Name' }));
  assert.ok(UpdateModelSchema.parse({ weight: 0.5 }));
  assert.ok(PaginationSchema.parse({ page: 2, limit: 5 }));
  assert.ok(LogQuerySchema.parse({ page: 1, limit: 10, status: 'success' }));
});

test('authenticate and admin guard', async () => {
  const { app, env } = createAppForTest();
  const req = new Request('https://example.com/api/channels', {
    method: METHODS.GET,
    headers: { Authorization: 'Bearer wrong' },
  });
  const res = await app.handleRequest(req, env);
  assert.equal(res.status, HTTP_STATUS.UNAUTHORIZED);

  const okReq = new Request('https://example.com/api/channels', {
    method: METHODS.GET,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  });
  const okRes = await app.handleRequest(okReq, env);
  assert.equal(okRes.status, HTTP_STATUS.OK);
});

test('initializeDatabase creates missing D1 tables', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(sql);
      return {
        bind: () => ({ run: async () => ({ success: true }) }),
        run: async () => ({ success: true }),
      };
    },
  };
  const env = makeTestEnv({ db });
  const app = createApp({});

  await app.initializeDatabase(env);
  assert.ok(calls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS channels')));
  assert.ok(calls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS channel_models')));
  assert.ok(calls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS request_logs')));
  assert.equal(env.__dbInitialized, true);

  const initialCallCount = calls.length;
  await app.initializeDatabase(env);
  assert.equal(calls.length, initialCallCount);
});

test('channel CRUD lifecycle', async () => {
  const { app, env, db } = createAppForTest();
  const createReq = makeJsonRequest({
    method: METHODS.POST,
    url: 'https://example.com/api/channel',
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: {
      name: 'OpenAI Official',
      key: 'openai-official',
      provider: 'openai',
      apiKey: 'sk-xxx',
      baseURL: '',
      models: [{ code: 'gpt-4o', name: 'GPT-4o' }],
    },
  });
  const createRes = await app.handleRequest(createReq, env);
  const createBody = await readJson(createRes);
  assert.equal(createRes.status, HTTP_STATUS.CREATED);
  assert.equal(createBody.success, true);
  assert.equal(createBody.data.models.length, 1);
  assert.equal(db.data.channels.length, 1);

  const duplicateReq = makeJsonRequest({
    method: METHODS.POST,
    url: 'https://example.com/api/channel',
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: {
      name: 'OpenAI Official',
      key: 'openai-official',
      provider: 'openai',
      apiKey: 'sk-xxx',
      baseURL: '',
      models: [{ code: 'gpt-4o', name: 'GPT-4o' }],
    },
  });
  const duplicateRes = await app.handleRequest(duplicateReq, env);
  assert.equal(duplicateRes.status, HTTP_STATUS.FORBIDDEN);

  const channelId = createBody.data.id;
  const getRes = await app.handleRequest(new Request(`https://example.com/api/channel/${channelId}`, {
    method: METHODS.GET,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  const getBody = await readJson(getRes);
  assert.equal(getBody.data.id, channelId);

  const updateReq = makeJsonRequest({
    method: METHODS.PUT,
    url: `https://example.com/api/channel/${channelId}`,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: { name: 'Updated Channel', models: [{ code: 'gpt-4o-mini', name: 'Mini' }] },
  });
  const updateRes = await app.handleRequest(updateReq, env);
  const updateBody = await readJson(updateRes);
  assert.equal(updateBody.data.name, 'Updated Channel');
  assert.equal(updateBody.data.models.length, 1);
  assert.equal(updateBody.data.models[0].code, 'gpt-4o-mini');

  const listRes = await app.handleRequest(new Request('https://example.com/api/channels?page=1&limit=10', {
    method: METHODS.GET,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  const listBody = await readJson(listRes);
  assert.equal(listBody.data.length, 1);

  const deleteRes = await app.handleRequest(new Request(`https://example.com/api/channel/${channelId}`, {
    method: METHODS.DELETE,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  assert.equal(deleteRes.status, HTTP_STATUS.OK);
  assert.equal(db.data.channels.length, 0);
});

test('model CRUD and log query', async () => {
  const { app, env } = createAppForTest({
    channels: [{
      id: 'ch-1',
      name: 'Channel',
      key: 'channel',
      provider: 'openai',
      api_key: 'sk',
      base_url: '',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    }],
    channel_models: [{
      id: 'm-1',
      channel_id: 'ch-1',
      code: 'gpt-4o',
      name: 'GPT-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-08T00:00:00.000Z',
      headers: '{}',
    }],
    request_logs: [{
      id: 'log-1',
      channel_id: 'ch-1',
      channel_name: 'Channel',
      model_id: 'm-1',
      model_code: 'gpt-4o',
      call_type: CALL_TYPES.CHAT,
      request_model: 'gpt-4o',
      status: 'success',
      error_message: '',
      latency_ms: 100,
      input_tokens: 5,
      output_tokens: 6,
      created_at: '2026-04-08T00:00:00.000Z',
    }],
  });

  const getModelRes = await app.handleRequest(new Request('https://example.com/api/model/m-1', {
    method: METHODS.GET,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  const getModelBody = await readJson(getModelRes);
  assert.equal(getModelBody.data.id, 'm-1');

  const updateModelReq = makeJsonRequest({
    method: METHODS.PUT,
    url: 'https://example.com/api/model/m-1',
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: { weight: 2.5 },
  });
  const updateModelRes = await app.handleRequest(updateModelReq, env);
  const updateModelBody = await readJson(updateModelRes);
  assert.equal(updateModelBody.data.weight, 2.5);

  const logRes = await app.handleRequest(new Request('https://example.com/api/log?page=1&limit=10&status=success', {
    method: METHODS.GET,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  const logBody = await readJson(logRes);
  assert.equal(logBody.data.length, 1);

  const deleteModelRes = await app.handleRequest(new Request('https://example.com/api/model/m-1', {
    method: METHODS.DELETE,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  assert.equal(deleteModelRes.status, HTTP_STATUS.OK);
});

test('status endpoint', async () => {
  const { app, env } = createAppForTest({
    channels: [{
      id: 'ch-1',
      name: 'Channel',
      key: 'channel',
      provider: 'openai',
      api_key: 'sk',
      base_url: '',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    }],
    channel_models: [{
      id: 'm-1',
      channel_id: 'ch-1',
      code: 'gpt-4o',
      name: 'GPT-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 10,
      success_rate: 0.9,
      error_rate: 0.1,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-08T00:00:00.000Z',
      headers: '{}',
    }],
  });

  const res = await app.handleRequest(new Request('https://example.com/status', { method: METHODS.GET }), env);
  const body = await readJson(res);
  assert.equal(body.models.length, 1);
  assert.equal(body.models[0].channel_name, 'Channel');
});

test('v1 proxy non-stream failover and models list', async () => {
  const { app, env, db } = createAppForTest({
    channels: [{
      id: 'ch-1',
      name: 'Channel',
      key: 'channel',
      provider: 'openai',
      api_key: 'sk',
      base_url: '',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    }],
    channel_models: [
      {
        id: 'm-1',
        channel_id: 'ch-1',
        code: 'fail-model',
        name: 'Fail Model',
        desc: '',
        aliases: '[]',
        call_type: CALL_TYPES.CHAT,
        capabilities: '["chat"]',
        cost: '',
        status: MODEL_STATUS.ACTIVE,
        weight: 2,
        avg_latency_ms: 0,
        success_rate: 1,
        error_rate: 0,
        consecutive_failures: 0,
        cooldown_until: null,
        last_updated: '2026-04-08T00:00:00.000Z',
        headers: '{}',
      },
      {
        id: 'm-2',
        channel_id: 'ch-1',
        code: 'ok-model',
        name: 'OK Model',
        desc: '',
        aliases: '["fail-model"]',
        call_type: CALL_TYPES.CHAT,
        capabilities: '["chat"]',
        cost: '',
        status: MODEL_STATUS.ACTIVE,
        weight: 1,
        avg_latency_ms: 0,
        success_rate: 1,
        error_rate: 0,
        consecutive_failures: 0,
        cooldown_until: null,
        last_updated: '2026-04-08T00:00:00.000Z',
        headers: '{}',
      },
    ],
  });

  const req = makeJsonRequest({
    method: METHODS.POST,
    url: `https://example.com${ROUTES.V1_CHAT}`,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: { model: 'fail-model', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  const res = await app.handleRequest(req, env);
  const body = await readJson(res);
  assert.equal(res.status, HTTP_STATUS.OK);
  assert.equal(body.choices[0].message.content, 'ok:1');
  assert.equal(db.data.request_logs.length, 2);

  const modelsRes = await app.handleRequest(new Request('https://example.com/v1/models', {
    method: METHODS.GET,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), env);
  const modelsBody = await readJson(modelsRes);
  assert.equal(modelsBody.object, 'list');
  assert.equal(modelsBody.data.length, 2);
});

test('v1 proxy stream uses fallback and emits sse', async () => {
  const { app, env, fallbackCalls } = createAppForTest({
    channels: [{
      id: 'ch-1',
      name: 'Channel',
      key: 'channel',
      provider: 'openai',
      api_key: 'sk',
      base_url: '',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    }],
    channel_models: [{
      id: 'm-1',
      channel_id: 'ch-1',
      code: 'ok-model',
      name: 'OK Model',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-08T00:00:00.000Z',
      headers: '{}',
    }],
  });

  const req = makeJsonRequest({
    method: METHODS.POST,
    url: `https://example.com${ROUTES.V1_CHAT}`,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: { model: 'ok-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  const res = await app.handleRequest(req, env);
  const text = await res.text();
  assert.ok(text.includes('data:'));
  assert.ok(text.includes('[DONE]'));
  assert.equal(fallbackCalls.length, 1);
});

test('v1 proxy rejects invalid body', async () => {
  const { app, env } = createAppForTest();
  const req = makeJsonRequest({
    method: METHODS.POST,
    url: `https://example.com${ROUTES.V1_CHAT}`,
    headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    body: { messages: [] },
  });
  const res = await app.handleRequest(req, env);
  const body = await readJson(res);
  assert.equal(res.status, HTTP_STATUS.BAD_REQUEST);
  assert.equal(body.error, ERROR_MESSAGES.INVALID_REQUEST_BODY);
});
