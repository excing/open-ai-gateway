import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createApp, CONSTANTS, SCHEMAS } from './worker.js';

const { CALL_TYPES, MODEL_STATUS, HTTP_STATUS, ERROR_MESSAGES, PROVIDERS, ROUTES } = CONSTANTS;

// Mock dependencies
function createMockEnv() {
  const channels = new Map();
  const models = new Map();
  const logs = [];

  return {
    ADMIN_KEY: 'test-admin-key',
    DB: {
      prepare: (sql) => {
        const normalizedSql = sql.trim().toLowerCase();
        
        return {
          bind: function(...args) {
            this._bindings = args;
            return this;
          },
          run: async function() {
            const bindings = this._bindings || [];
            
            // INSERT channel
            if (normalizedSql.includes('insert into channels')) {
              const [id, name, key, provider, apiKey, baseURL, createdAt, updatedAt] = bindings;
              channels.set(id, { id, name, key, provider, api_key: apiKey, base_url: baseURL, created_at: createdAt, updated_at: updatedAt });
              return { success: true };
            }
            
            // INSERT model
            if (normalizedSql.includes('insert into channel_models')) {
              const [id, channelId, code, name, desc, aliases, callType, capabilities, cost, status, weight] = bindings;
              models.set(id, { 
                id, channel_id: channelId, code, name, desc, aliases, call_type: callType, 
                capabilities, cost, status, weight, avg_latency_ms: 0, success_rate: 1, error_rate: 0,
                consecutive_failures: 0, cooldown_until: null, last_updated: new Date().toISOString(), headers: '{}'
              });
              return { success: true };
            }
            
            // DELETE models by channel
            if (normalizedSql.includes('delete from channel_models where channel_id')) {
              for (const [id, m] of models) {
                if (m.channel_id === bindings[0]) models.delete(id);
              }
              return { success: true };
            }
            
            // DELETE channel
            if (normalizedSql.includes('delete from channels where id')) {
              channels.delete(bindings[0]);
              return { success: true };
            }
            
            // DELETE model
            if (normalizedSql.includes('delete from channel_models where id')) {
              models.delete(bindings[0]);
              return { success: true };
            }
            
            // UPDATE channel
            if (normalizedSql.includes('update channels set')) {
              const channel = channels.get(bindings[bindings.length - 1]);
              if (channel) {
                return { success: true };
              }
              return { success: false };
            }
            
            // UPDATE model stats
            if (normalizedSql.includes('update channel_models set')) {
              return { success: true };
            }
            
            // INSERT log
            if (normalizedSql.includes('insert into request_logs')) {
              logs.push({ id: bindings[0], channel_id: bindings[1], channel_name: bindings[2], model_id: bindings[3] });
              return { success: true };
            }
            
            return { success: true };
          },
          all: async function() {
            const bindings = this._bindings || [];
            
            // SELECT models by channel id
            if (normalizedSql.includes('from channel_models where channel_id')) {
              const channelId = bindings[0];
              const results = Array.from(models.values()).filter(m => m.channel_id === channelId);
              return { results };
            }
            
            // SELECT channel by id
            if (normalizedSql.includes('select * from channels where id')) {
              const channel = channels.get(bindings[0]);
              return { results: channel ? [channel] : [] };
            }
            
            // SELECT channel by key
            if (normalizedSql.includes('select * from channels where key')) {
              const channel = Array.from(channels.values()).find(c => c.key === bindings[0]);
              return { results: channel ? [channel] : [] };
            }
            
            // SELECT model by id
            if (normalizedSql.includes('select * from channel_models where id')) {
              const model = models.get(bindings[0]);
              return { results: model ? [model] : [] };
            }
            
            // COUNT channels
            if (normalizedSql.includes('select count(*)')) {
              if (normalizedSql.includes('from channels')) {
                return { results: [{ total: channels.size }] };
              }
              if (normalizedSql.includes('from request_logs')) {
                return { results: [{ total: logs.size }] };
              }
            }
            
            // SELECT channels paged
            if (normalizedSql.includes('select * from channels order by')) {
              const limit = bindings[0];
              const offset = bindings[1];
              const results = Array.from(channels.values()).slice(offset, offset + limit);
              return { results };
            }
            
            // SELECT status base (join)
            if (normalizedSql.includes('from channel_models cm join channels c')) {
              const results = Array.from(models.values()).map(m => {
                const ch = channels.get(m.channel_id);
                return { ...m, channel_name: ch?.name || 'unknown' };
              });
              return { results };
            }
            
            // SELECT models by identifier
            if (normalizedSql.includes('where (cm.code =') || normalizedSql.includes('cm.aliases like')) {
              const modelIdentifier = bindings[0];
              const results = Array.from(models.values())
                .filter(m => m.code === modelIdentifier)
                .map(m => {
                  const ch = channels.get(m.channel_id);
                  return { ...m, ch_id: ch?.id, ch_name: ch?.name, ch_key: ch?.key, provider: ch?.provider, api_key: ch?.api_key, base_url: ch?.base_url };
                });
              return { results };
            }
            
            // SELECT logs
            if (normalizedSql.includes('from request_logs')) {
              return { results: logs.slice(0, bindings[bindings.length - 2] || 20) };
            }
            
            return { results: [] };
          },
          first: async function() {
            const bindings = this._bindings || [];
            
            if (normalizedSql.includes('select * from channels where id')) {
              return channels.get(bindings[0]);
            }
            if (normalizedSql.includes('select * from channels where key')) {
              return Array.from(channels.values()).find(c => c.key === bindings[0]);
            }
            if (normalizedSql.includes('select * from channel_models where id')) {
              return models.get(bindings[0]);
            }
            if (normalizedSql.includes('select count(*)')) {
              if (normalizedSql.includes('from channels')) {
                return { total: channels.size };
              }
              return { total: logs.length };
            }
            
            return null;
          },
        };
      },
    },
    ctx: {
      waitUntil: (promise) => promise,
    },
    __dbInitialized: true,
    
    // Test helpers
    _channels: channels,
    _models: models,
    _logs: logs,
    _addChannel: (ch) => channels.set(ch.id, ch),
    _addModel: (m) => models.set(m.id, m),
    _clear: () => { channels.clear(); models.clear(); logs.length = 0; },
  };
}

function createMockRequest(options = {}) {
  const { method = 'GET', pathname = '/', headers = {}, body = null } = options;
  const url = `https://example.com${pathname}`;
  
  return {
    method,
    url,
    headers: {
      get: (key) => headers[key.toLowerCase()],
      ...headers,
    },
    json: async () => body,
    formData: async () => new Map(Object.entries(body || {})),
  };
}

// Mock fetch for upstream API calls
function createMockFetch(mockResponses = {}) {
  return async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    
    // Check for mock responses
    for (const [pattern, response] of Object.entries(mockResponses)) {
      if (urlStr.includes(pattern)) {
        return {
          ok: response.ok !== false,
          status: response.status || 200,
          json: async () => response.data || response,
        };
      }
    }
    
    // Default: return empty models list
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: [] }),
    };
  };
}

describe('API: GET /api/channel/:id/models - 获取指定渠道上游的模型列表', () => {
  let app;
  let mockEnv;
  
  beforeEach(() => {
    mockEnv = createMockEnv();
  });
  
  afterEach(() => {
    mockEnv._clear();
  });
  
  it('应从OpenAI上游获取模型列表', async () => {
    const channelId = 'ch-001';
    mockEnv._addChannel({
      id: channelId,
      name: 'OpenAI Channel',
      key: 'openai-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    // Mock fetch to return OpenAI models
    const mockFetch = createMockFetch({
      'api.openai.com/v1/models': {
        object: 'list',
        data: [
          { id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' },
          { id: 'gpt-4o-mini', object: 'model', created: 1700000001, owned_by: 'openai' },
          { id: 'dall-e-3', object: 'model', created: 1700000002, owned_by: 'openai' },
        ],
      },
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-' + Date.now(),
      fetch: mockFetch,
    });
    
    const request = createMockRequest({
      method: 'GET',
      pathname: `/api/channel/${channelId}/models`,
      headers: { 'authorization': 'Bearer test-admin-key' },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data));
    assert.strictEqual(data.data.length, 3);
    assert.strictEqual(data.data[0].id, 'gpt-4o');
    assert.strictEqual(data.data[1].id, 'gpt-4o-mini');
    assert.strictEqual(data.data[2].id, 'dall-e-3');
  });
  
  it('应从OpenRouter上游获取模型列表', async () => {
    const channelId = 'ch-002';
    mockEnv._addChannel({
      id: channelId,
      name: 'OpenRouter Channel',
      key: 'openrouter-channel',
      provider: PROVIDERS.OPENROUTER,
      api_key: 'sk-or-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    const mockFetch = createMockFetch({
      'openrouter.ai/api/v1/models': {
        object: 'list',
        data: [
          { id: 'anthropic/claude-sonnet-4', object: 'model', created: 1700000000, owned_by: 'anthropic' },
          { id: 'openai/gpt-4o', object: 'model', created: 1700000001, owned_by: 'openai' },
        ],
      },
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-' + Date.now(),
      fetch: mockFetch,
    });
    
    const request = createMockRequest({
      method: 'GET',
      pathname: `/api/channel/${channelId}/models`,
      headers: { 'authorization': 'Bearer test-admin-key' },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data));
    assert.strictEqual(data.data.length, 2);
  });
  
  it('Anthropic渠道应返回空数组（无公开API）', async () => {
    const channelId = 'ch-003';
    mockEnv._addChannel({
      id: channelId,
      name: 'Anthropic Channel',
      key: 'anthropic-channel',
      provider: PROVIDERS.ANTHROPIC,
      api_key: 'sk-ant-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-' + Date.now(),
    });
    
    const request = createMockRequest({
      method: 'GET',
      pathname: `/api/channel/${channelId}/models`,
      headers: { 'authorization': 'Bearer test-admin-key' },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data));
    assert.strictEqual(data.data.length, 0);
  });
  
  it('渠道不存在时应返回404', async () => {
    app = createApp();
    
    const request = createMockRequest({
      method: 'GET',
      pathname: '/api/channel/non-existent/models',
      headers: { 'authorization': 'Bearer test-admin-key' },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.NOT_FOUND);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error, ERROR_MESSAGES.CHANNEL_NOT_FOUND);
  });
  
  it('未鉴权时应返回401', async () => {
    app = createApp();
    
    const request = createMockRequest({
      method: 'GET',
      pathname: '/api/channel/ch-001/models',
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.UNAUTHORIZED);
  });
  
  it('上游API错误时应返回空数组和错误信息', async () => {
    const channelId = 'ch-001';
    mockEnv._addChannel({
      id: channelId,
      name: 'OpenAI Channel',
      key: 'openai-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'invalid-key',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    const mockFetch = createMockFetch({
      'api.openai.com/v1/models': {
        ok: false,
        status: 401,
        data: { error: { message: 'Invalid API key' } },
      },
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-' + Date.now(),
      fetch: mockFetch,
    });
    
    const request = createMockRequest({
      method: 'GET',
      pathname: `/api/channel/${channelId}/models`,
      headers: { 'authorization': 'Bearer test-admin-key' },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data));
    assert.strictEqual(data.data.length, 0);
    assert.ok(data.error);
  });
  
  it('应使用自定义baseURL', async () => {
    const channelId = 'ch-001';
    mockEnv._addChannel({
      id: channelId,
      name: 'Custom OpenAI Channel',
      key: 'custom-openai',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-custom',
      base_url: 'https://custom-api.example.com',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    let capturedUrl = null;
    const mockFetch = async (url, options) => {
      capturedUrl = url.toString();
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: [{ id: 'custom-model', object: 'model', created: 0, owned_by: 'custom' }] }),
      };
    };
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-' + Date.now(),
      fetch: mockFetch,
    });
    
    const request = createMockRequest({
      method: 'GET',
      pathname: `/api/channel/${channelId}/models`,
      headers: { 'authorization': 'Bearer test-admin-key' },
    });
    
    await app.handleRequest(request, mockEnv);
    
    assert.ok(capturedUrl.includes('custom-api.example.com'));
    assert.ok(capturedUrl.includes('/v1/models'));
  });
});

describe('API: POST /api/channel/:id/model/:modelId/check - 检测模型可用性', () => {
  let app;
  let mockEnv;
  
  beforeEach(() => {
    mockEnv = createMockEnv();
  });
  
  afterEach(() => {
    mockEnv._clear();
  });
  
  it('chat模型应检测API可访问且有非空文本响应', async () => {
    const channelId = 'ch-001';
    const modelId = 'model-001';
    
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    mockEnv._addModel({
      id: modelId,
      channel_id: channelId,
      code: 'gpt-4o',
      name: 'GPT-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1.0,
      avg_latency_ms: 0,
      success_rate: 1.0,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    
    // Mock AI response
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => ({ text: 'Hello, this is a test response.', usage: { promptTokens: 5, completionTokens: 10 } }),
        streamText: async () => ({ textStream: ['Hello'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test-base64' }] }),
        embed: async () => ({ embedding: [0.1, 0.2], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array(), mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async () => ({ text: 'transcribed' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/${modelId}/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data);
    assert.strictEqual(data.data.model_id, modelId);
    assert.strictEqual(data.data.model_code, 'gpt-4o');
    assert.strictEqual(data.data.call_type, CALL_TYPES.CHAT);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
    assert.ok(data.data.latency_ms >= 0);
  });
  
  it('image_gen模型应检测API可访问且有图片响应', async () => {
    const channelId = 'ch-001';
    const modelId = 'model-002';
    
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    mockEnv._addModel({
      id: modelId,
      channel_id: channelId,
      code: 'dall-e-3',
      name: 'DALL-E 3',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.IMAGE_GEN,
      capabilities: '["image_out"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1.0,
      avg_latency_ms: 0,
      success_rate: 1.0,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => ({ text: 'test', usage: {} }),
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test-base64-image-data' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array([1,2,3]), mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async () => ({ text: 'test' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/${modelId}/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
    assert.ok(data.data.latency_ms >= 0);
  });
  
  it('API不可访问时应返回api_accessible=false', async () => {
    const channelId = 'ch-001';
    const modelId = 'model-001';
    
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'invalid-key',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    mockEnv._addModel({
      id: modelId,
      channel_id: channelId,
      code: 'gpt-4o',
      name: 'GPT-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1.0,
      avg_latency_ms: 0,
      success_rate: 1.0,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => { throw new Error('API Error: Invalid API key'); },
        streamText: async () => { throw new Error('API Error'); },
        generateImage: async () => { throw new Error('API Error'); },
        embed: async () => { throw new Error('API Error'); },
        experimental_generateSpeech: async () => { throw new Error('API Error'); },
        experimental_transcribe: async () => { throw new Error('API Error'); },
        experimental_generateVideo: async () => { throw new Error('API Error'); },
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/${modelId}/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
    assert.ok(data.data.error_message);
  });
  
  it('响应数据为空时应返回data_available=false', async () => {
    const channelId = 'ch-001';
    const modelId = 'model-001';
    
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    mockEnv._addModel({
      id: modelId,
      channel_id: channelId,
      code: 'gpt-4o',
      name: 'GPT-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1.0,
      avg_latency_ms: 0,
      success_rate: 1.0,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => ({ text: '', usage: {} }), // 空响应
        streamText: async () => ({ textStream: [], usage: {} }),
        generateImage: async () => ({ images: [] }),
        embed: async () => ({ embedding: [], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: null, mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async () => ({ text: '' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/${modelId}/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible); // API 可访问
    assert.strictEqual(data.data.data_available, false); // 但数据为空
  });
  
  it('渠道不存在时应返回404', async () => {
    app = createApp();
    
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/channel/non-existent/model/model-001/check',
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.NOT_FOUND);
    assert.strictEqual(data.success, false);
  });
  
  it('模型不存在时应返回404', async () => {
    const channelId = 'ch-001';
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    app = createApp();
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/non-existent/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.NOT_FOUND);
    assert.strictEqual(data.success, false);
  });
  
  it('未鉴权时应返回401', async () => {
    app = createApp();
    
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/channel/ch-001/model/model-001/check',
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.UNAUTHORIZED);
  });
  
  it('embedding模型应检测API可访问且有向量响应', async () => {
    const channelId = 'ch-001';
    const modelId = 'model-003';
    
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    mockEnv._addModel({
      id: modelId,
      channel_id: channelId,
      code: 'text-embedding-3-small',
      name: 'Embedding Small',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.EMBEDDING,
      capabilities: '["embedding"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1.0,
      avg_latency_ms: 0,
      success_rate: 1.0,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => ({ text: 'test', usage: {} }),
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5], usage: { promptTokens: 3 } }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array(), mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async () => ({ text: 'test' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/${modelId}/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
  });
  
  it('audio_gen模型应检测API可访问且有音频响应', async () => {
    const channelId = 'ch-001';
    const modelId = 'model-004';
    
    mockEnv._addChannel({
      id: channelId,
      name: 'Test Channel',
      key: 'test-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    
    mockEnv._addModel({
      id: modelId,
      channel_id: channelId,
      code: 'tts-1',
      name: 'TTS 1',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.AUDIO_GEN,
      capabilities: '["audio_out"]',
      cost: '',
      status: MODEL_STATUS.ACTIVE,
      weight: 1.0,
      avg_latency_ms: 0,
      success_rate: 1.0,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => ({ text: 'test', usage: {} }),
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({ 
          audio: { data: new Uint8Array([1, 2, 3, 4, 5]), mediaType: 'audio/mpeg' } 
        }),
        experimental_transcribe: async () => ({ text: 'test' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/channel/${channelId}/model/${modelId}/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {},
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
  });
});