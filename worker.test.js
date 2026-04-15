import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createApp, CONSTANTS, SCHEMAS } from './worker.js';

const {
  CALL_TYPES,
  MODEL_STATUS,
  HTTP_STATUS,
  ERROR_MESSAGES,
  PROVIDERS,
  ROUTES,
  HEADERS,
  MULTIPART_CONTENT_TYPE,
} = CONSTANTS;

// Mock dependencies
function createMockEnv() {
  const channels = new Map();
  const models = new Map();
  const logs = [];

  return {
    ADMIN_KEY: 'test-admin-key',
    ENV: 'dev',
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
              const [id, name, key, provider, apiKey, baseURL, weight, createdAt, updatedAt] = bindings;
              channels.set(id, {
                id,
                name,
                key,
                provider,
                api_key: apiKey,
                base_url: baseURL,
                weight,
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { success: true };
            }
            
            // INSERT model
            if (normalizedSql.includes('insert into channel_models')) {
              const [id, channelId, code, name, desc, aliases, callType, capabilities, inputCost, outputCost, status, weight] = bindings;
              models.set(id, { 
                id, channel_id: channelId, code, name, desc, aliases, call_type: callType, 
                capabilities, input_cost: inputCost, output_cost: outputCost, status, weight, avg_latency_ms: 0, success_rate: 1, error_rate: 0,
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
              logs.push({
                id: bindings[0],
                channel_id: bindings[1],
                channel_name: bindings[2],
                model_id: bindings[3],
                input_cost: bindings[12],
                output_cost: bindings[13],
                created_at: bindings[14],
              });
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
            
            // SELECT models by identifier
            if (normalizedSql.includes('where (cm.code =') || normalizedSql.includes('cm.aliases like')) {
              const modelIdentifier = bindings[0];
              const results = Array.from(models.values())
                .filter(m => m.code === modelIdentifier)
                .map(m => {
                  const ch = channels.get(m.channel_id);
                  return {
                    ...m,
                    ch_id: ch?.id,
                    ch_name: ch?.name,
                    ch_key: ch?.key,
                    provider: ch?.provider,
                    api_key: ch?.api_key,
                    base_url: ch?.base_url,
                    ch_weight: ch?.weight ?? 1,
                  };
                });
              return { results };
            }

            // SELECT status base (join)
            if (normalizedSql.includes('select cm.*, c.name as channel_name from channel_models cm join channels c')) {
              const results = Array.from(models.values()).map(m => {
                const ch = channels.get(m.channel_id);
                return { ...m, channel_name: ch?.name || 'unknown' };
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

  it('Pollinations渠道应调用 /v1/models 获取模型列表', async () => {
    const channelId = 'ch-004';
    mockEnv._addChannel({
      id: channelId,
      name: 'Pollinations Channel',
      key: 'pollinations-channel',
      provider: PROVIDERS.POLLINATIONS,
      api_key: 'pollinations-key',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });

    const mockFetch = createMockFetch({
      'gen.pollinations.ai/v1/models': {
        object: 'list',
        data: [
          { id: 'flux', object: 'model', created: 1700000000, owned_by: 'pollinations' },
          { id: 'veo', object: 'model', created: 1700000001, owned_by: 'pollinations' },
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
      headers: { authorization: 'Bearer test-admin-key' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data));
    assert.strictEqual(data.data.length, 2);
    assert.strictEqual(data.data[0].id, 'flux');
    assert.strictEqual(data.data[1].id, 'veo');
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

describe('API: POST /api/channel/models - 通过连接参数获取上游模型列表', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('应根据provider/apiKey/baseURL获取模型列表', async () => {
    const mockFetch = createMockFetch({
      'api.openai.com/v1/models': {
        ok: true,
        status: 200,
        data: { object: 'list', data: [{ id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' }] },
      },
    });
    app = createApp({ fetch: mockFetch });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/channel/models',
      headers: { authorization: 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data[0].id, 'gpt-4o');
  });

  it('缺少apiKey时应返回400', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/channel/models',
      headers: { authorization: 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, baseURL: '' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
  });

  it('请求体解析失败时应返回具体错误原因', async () => {
    app = createApp();

    const request = {
      method: 'POST',
      url: 'https://example.com/api/channel/models',
      headers: {
        get: (key) => {
          const normalizedKey = key.toLowerCase();
          if (normalizedKey === 'authorization') return 'Bearer test-admin-key';
          if (normalizedKey === 'content-type') return 'application/json';
          return undefined;
        },
      },
      json: async () => {
        throw new Error('Malformed JSON payload');
      },
      formData: async () => new Map(),
    };

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error, `${ERROR_MESSAGES.INVALID_REQUEST_BODY}: Malformed JSON payload`);
  });
});

describe('API: POST /api/model/check - 检测模型可用性', () => {
  let app;
  let mockEnv;
  
  beforeEach(() => {
    mockEnv = createMockEnv();
  });
  
  afterEach(() => {
    mockEnv._clear();
  });

  it('chat模型应检测API可访问且有非空文本响应', async () => {
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
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', model: 'gpt-4o', callType: CALL_TYPES.CHAT, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data);
    assert.strictEqual(data.data.model_code, 'gpt-4o');
    assert.strictEqual(data.data.call_type, CALL_TYPES.CHAT);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
    assert.ok(data.data.latency_ms >= 0);
  });

  it('image_gen模型应检测API可访问且有图片响应', async () => {
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
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', model: 'dall-e-3', callType: CALL_TYPES.IMAGE_GEN, headers: {} },
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
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'invalid-key', baseURL: '', model: 'gpt-4o', callType: CALL_TYPES.CHAT, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
    assert.ok(data.data.error_message);
  });

  it('检测超时时应返回api_accessible=false和超时错误信息', async () => {
    app = createApp({
      ai: {
        generateText: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { text: 'late response', usage: {} };
        },
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array([1]), mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async () => ({ text: 'test' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: {
        provider: PROVIDERS.OPENAI,
        apiKey: 'sk-test',
        baseURL: '',
        model: 'gpt-4o',
        callType: CALL_TYPES.CHAT,
        headers: {},
        timeoutMs: 10,
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
    assert.ok(data.data.error_message.includes('Model check timed out after 10ms'));
  });

  it('响应数据为空时应返回data_available=false', async () => {
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
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', model: 'gpt-4o', callType: CALL_TYPES.CHAT, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible); // API 可访问
    assert.strictEqual(data.data.data_available, false); // 但数据为空
  });
  
  it('请求缺少apiKey时应返回400', async () => {
    app = createApp();
    
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, baseURL: '', model: 'gpt-4o', callType: CALL_TYPES.CHAT, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
  });

  it('无需模型入库时仍应执行上游检测', async () => {
    app = createApp({
      ai: {
        generateText: async () => ({ text: 'ok', usage: {} }),
        streamText: async () => ({ textStream: ['ok'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array([1]), mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async () => ({ text: 'ok' }),
        experimental_generateVideo: async () => ({ videos: [{ url: 'https://test.example/video.mp4' }] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', model: 'not-in-db-model', callType: CALL_TYPES.CHAT, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.model_code, 'not-in-db-model');
    assert.strictEqual(data.data.call_type, CALL_TYPES.CHAT);
  });

  it('未鉴权时应返回401', async () => {
    app = createApp();
    
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.UNAUTHORIZED);
  });

  it('embedding模型应检测API可访问且有向量响应', async () => {
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
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', model: 'text-embedding-3-small', callType: CALL_TYPES.EMBEDDING, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
  });

  it('audio_gen模型应检测API可访问且有音频响应', async () => {
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-check',
      ai: {
        generateText: async () => ({ text: 'test', usage: {} }),
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({
          audio: { uint8Array: new Uint8Array([1, 2, 3, 4, 5]), mediaType: 'audio/mpeg' }
        }),
        experimental_transcribe: async () => ({ text: 'test' }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });
    
    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', model: 'tts-1', callType: CALL_TYPES.AUDIO_GEN, headers: {} },
    });
    
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.api_accessible);
    assert.ok(data.data.data_available);
  });

  it('transcribe模型应读取public音频文件并执行真实检测', async () => {
    let receivedAudio;
    const expectedAudio = new Uint8Array([10, 20, 30, 40]);

    app = createApp({
      fetch: async (input) => {
        const requestUrl = typeof input === 'string' ? input : input.url;
        if (requestUrl.endsWith('/hellowhatareyoudoing.mp3')) {
          return new Response(expectedAudio.buffer, { status: HTTP_STATUS.OK });
        }
        return new Response('Not Found', { status: HTTP_STATUS.NOT_FOUND });
      },
      ai: {
        generateText: async () => ({ text: 'test', usage: {} }),
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array([1]), mediaType: 'audio/mpeg' } }),
        experimental_transcribe: async ({ audio }) => {
          receivedAudio = audio;
          return { text: 'transcribed from model check audio' };
        },
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/model/check`,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: PROVIDERS.OPENAI,
        apiKey: 'sk-test',
        baseURL: '',
        model: 'whisper-1',
        callType: CALL_TYPES.TRANSCRIBE,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
    assert.ok(receivedAudio instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(receivedAudio), Array.from(expectedAudio));
  });

  it('请求缺少model时应返回400', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: `/api/model/check`,
      headers: { 'authorization': 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', callType: CALL_TYPES.CHAT, headers: {} },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
  });
});

describe('API: POST /v1/audio/transcriptions - multipart file', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-transcribe',
      name: 'Transcribe Channel',
      key: 'transcribe-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'model-transcribe',
      channel_id: 'ch-transcribe',
      code: 'whisper-1',
      name: 'whisper-1',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.TRANSCRIBE,
      capabilities: JSON.stringify([CALL_TYPES.TRANSCRIBE]),
      input_cost: '0',
      output_cost: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('应将multipart file对象转换为Uint8Array后再调用SDK', async () => {
    let receivedAudio;
    const expectedAudio = new Uint8Array([1, 2, 3, 4]);
    const mockFile = {
      arrayBuffer: async () => expectedAudio.buffer,
    };

    app = createApp({
      providers: {
        createOpenAI: () => ({
          transcription: (modelCode) => ({ modelCode }),
        }),
      },
      ai: {
        experimental_transcribe: async ({ audio }) => {
          receivedAudio = audio;
          return { text: 'ok' };
        },
        generateText: async () => ({ text: 'test', usage: {} }),
        streamText: async () => ({ textStream: ['test'], usage: {} }),
        generateImage: async () => ({ images: [{ base64: 'test' }] }),
        embed: async () => ({ embedding: [0.1], usage: {} }),
        experimental_generateSpeech: async () => ({ audio: { data: new Uint8Array([1]), mediaType: 'audio/mpeg' } }),
        experimental_generateVideo: async () => ({ videos: [] }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_TRANSCRIBE,
      headers: {
        authorization: 'Bearer test-admin-key',
        [HEADERS.CONTENT_TYPE.toLowerCase()]: `${MULTIPART_CONTENT_TYPE}; boundary=----test-boundary`,
      },
      body: {
        model: 'whisper-1',
        file: mockFile,
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.text, 'ok');
    assert.ok(receivedAudio instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(receivedAudio), Array.from(expectedAudio));
  });
});

describe('API: 参数校验错误应返回具体原因', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    app = createApp();
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('创建渠道缺少apiKey时应包含字段级错误', async () => {
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/channel',
      headers: { authorization: 'Bearer test-admin-key' },
      body: { name: 'OpenAI', key: 'openai', provider: PROVIDERS.OPENAI, baseURL: '' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
    assert.ok(data.error.startsWith(`${ERROR_MESSAGES.INVALID_REQUEST_BODY}:`));
    assert.ok(data.error.includes('apiKey'));
  });

  it('模型检测缺少model时应包含字段级错误', async () => {
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '', callType: CALL_TYPES.CHAT, headers: {} },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
    assert.ok(data.error.startsWith(`${ERROR_MESSAGES.INVALID_REQUEST_BODY}:`));
    assert.ok(data.error.includes('model'));
  });

  it('渠道列表分页参数非法时应返回400并包含page错误', async () => {
    const request = createMockRequest({
      method: 'GET',
      pathname: '/api/channels?page=0&limit=20',
      headers: { authorization: 'Bearer test-admin-key' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
    assert.ok(data.error.startsWith(`${ERROR_MESSAGES.INVALID_REQUEST_BODY}:`));
    assert.ok(data.error.includes('page'));
  });

  it('日志查询分页参数非法时应返回400并包含limit错误', async () => {
    const request = createMockRequest({
      method: 'GET',
      pathname: '/api/log?page=1&limit=1000',
      headers: { authorization: 'Bearer test-admin-key' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(data.success, false);
    assert.ok(data.error.startsWith(`${ERROR_MESSAGES.INVALID_REQUEST_BODY}:`));
    assert.ok(data.error.includes('limit'));
  });
});

describe('Pollinations: 仅图片与视频生成', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('pollinations 的 image_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url) => {
        const target = url.toString();
        if (target.includes('/image/')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: PROVIDERS.POLLINATIONS,
        apiKey: 'not-required',
        baseURL: '',
        model: 'flux',
        callType: CALL_TYPES.IMAGE_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
  });

  it('pollinations 的 video_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url) => {
        const target = url.toString();
        if (target.includes('/video/')) {
          return new Response(new Uint8Array([4, 5, 6]), {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: PROVIDERS.POLLINATIONS,
        apiKey: 'not-required',
        baseURL: '',
        model: 'veo',
        callType: CALL_TYPES.VIDEO_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
  });

  it('pollinations 的 chat 模型检测应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: PROVIDERS.POLLINATIONS,
        apiKey: 'not-required',
        baseURL: '',
        model: 'openai',
        callType: CALL_TYPES.CHAT,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.SERVICE_UNAVAILABLE);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
  });
});

describe('Exacg: 仅图片生成', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('exacg 的 image_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        if (target.includes('sd.exacg.cc/api/v1/generate_image')) {
          assert.strictEqual(options.method, 'POST');
          return new Response(JSON.stringify({
            success: true,
            message: '图像生成成功',
            data: {
              image_url: 'https://example.com/image.jpg',
              image_id: 'abc-1',
              model_name: 'model-0',
              points_used: 1,
              remaining_points: 99,
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (target.includes('https://example.com/image.jpg')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'exacg',
        apiKey: 'exacg-key',
        baseURL: '',
        model: '0',
        callType: CALL_TYPES.IMAGE_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
  });

  it('exacg 成功响应为 data.image_url 时应能下载并返回图片', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        if (target.includes('sd.exacg.cc/api/v1/generate_image')) {
          assert.strictEqual(options.method, 'POST');
          return new Response(JSON.stringify({
            success: true,
            message: '图像生成成功',
            data: {
              image_url: 'https://example.com/image.jpg',
              image_id: '12345',
              model_name: 'test-model',
              points_used: 1,
              remaining_points: 99,
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (target.includes('https://example.com/image.jpg')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'exacg',
        apiKey: 'exacg-key',
        baseURL: '',
        model: '0',
        callType: CALL_TYPES.IMAGE_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
  });

  it('exacg 失败响应为 { error } 时应返回不可用并带错误信息', async () => {
    app = createApp({
      fetch: async (url) => {
        const target = url.toString();
        if (target.includes('sd.exacg.cc/api/v1/generate_image')) {
          return new Response(JSON.stringify({ error: '错误描述信息' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'exacg',
        apiKey: 'exacg-key',
        baseURL: '',
        model: '0',
        callType: CALL_TYPES.IMAGE_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
    assert.ok(data.data.error_message.includes('错误描述信息'));
  });

  it('exacg 的 chat 模型检测应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'exacg',
        apiKey: 'exacg-key',
        baseURL: '',
        model: '0',
        callType: CALL_TYPES.CHAT,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.SERVICE_UNAVAILABLE);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
  });
});

describe('Microsoft TTS: 仅语音生成且模型固定 default', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('microsoft-tts 的 audio_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/tts'));
        assert.ok(target.includes('api_key=ms-key'));
        assert.ok(target.includes('t='));
        assert.strictEqual(options.method, 'GET');
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'microsoft-tts',
        apiKey: 'ms-key',
        baseURL: 'https://tts.example.com',
        model: 'microsoft-tts',
        callType: CALL_TYPES.AUDIO_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
  });

  it('microsoft-tts 非 default 模型应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'microsoft-tts',
        apiKey: 'ms-key',
        baseURL: 'https://tts.example.com',
        model: 'microsoft-tts',
        callType: CALL_TYPES.AUDIO_GEN,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
  });

  it('microsoft-tts 的 chat 模型检测应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'microsoft-tts',
        apiKey: 'ms-key',
        baseURL: 'https://tts.example.com',
        model: 'microsoft-tts',
        callType: CALL_TYPES.CHAT,
        headers: {},
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.SERVICE_UNAVAILABLE);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
  });
});

describe('extra_body 透传', () => {
  it('executeAIRequest(chat) 应透传 extra_body 到 generateText.providerOptions', async () => {
    let receivedOptions;
    const app = createApp({
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'ok', usage: {} };
        },
      },
    });

    const extraBody = { openai: { reasoningEffort: 'high' } };
    const result = await app.executeAIRequest(
      { modelId: 'mock-model' },
      CALL_TYPES.CHAT,
      { prompt: 'hello', extra_body: extraBody },
    );

    assert.strictEqual(result.text, 'ok');
    assert.deepStrictEqual(receivedOptions.providerOptions, extraBody);
  });

  it('POST /v1/chat/completions stream=true 应透传 extra_body 到 streamText.providerOptions', async () => {
    let receivedOptions;
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: (modelCode) => ({ modelCode }),
        }),
      },
      ai: {
        streamText: async (options) => {
          receivedOptions = options;
          return { textStream: ['ok'] };
        },
      },
    });
    const mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-stream-provider-options',
      name: 'OpenAI',
      key: 'openai-stream-provider-options',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'model-stream-provider-options',
      channel_id: 'ch-stream-provider-options',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_cost: '0',
      output_cost: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });

    const extraBody = { openrouter: { transforms: ['middle-out'] } };
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        extra_body: extraBody,
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.deepStrictEqual(receivedOptions.providerOptions, extraBody);
    mockEnv._clear();
  });

  it('POST /api/model/check 应透传 extra_body 到检测请求的 providerOptions', async () => {
    let receivedOptions;
    const app = createApp({
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'ok', usage: {} };
        },
      },
    });
    const mockEnv = createMockEnv();
    const extraBody = { anthropic: { thinking: { type: 'enabled', budgetTokens: 128 } } };
    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: PROVIDERS.OPENAI,
        apiKey: 'sk-test',
        baseURL: '',
        model: 'gpt-4o',
        callType: CALL_TYPES.CHAT,
        headers: {},
        extra_body: extraBody,
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.deepStrictEqual(receivedOptions.providerOptions, extraBody);
    mockEnv._clear();
  });

  it('executeAIRequest(chat) 在无 extra_body 时应回退 providerOptions 字段', async () => {
    let receivedOptions;
    const app = createApp({
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'ok', usage: {} };
        },
      },
    });

    const providerOptions = { openai: { reasoningEffort: 'low' } };
    await app.executeAIRequest(
      { modelId: 'mock-model' },
      CALL_TYPES.CHAT,
      { prompt: 'hello', providerOptions },
    );

    assert.deepStrictEqual(receivedOptions.providerOptions, providerOptions);
  });
});

describe('V1 参数完整透传', () => {
  it('executeAIRequest(chat) 应透传完整聊天参数', async () => {
    let receivedOptions;
    const app = createApp({
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'ok', usage: {} };
        },
      },
    });
    await app.executeAIRequest(
      { modelId: 'chat-model' },
      CALL_TYPES.CHAT,
      {
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 128,
        temperature: 0.7,
        top_p: 0.9,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
        stop: ['DONE'],
        seed: 42,
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        extra_body: { openai: { reasoningEffort: 'medium' } },
      },
    );

    assert.strictEqual(receivedOptions.maxTokens, 128);
    assert.strictEqual(receivedOptions.topP, 0.9);
    assert.strictEqual(receivedOptions.frequencyPenalty, 0.2);
    assert.strictEqual(receivedOptions.presencePenalty, 0.1);
    assert.deepStrictEqual(receivedOptions.stopSequences, ['DONE']);
    assert.strictEqual(receivedOptions.seed, 42);
    assert.deepStrictEqual(receivedOptions.tools, [{ type: 'function', function: { name: 'get_weather' } }]);
    assert.strictEqual(receivedOptions.toolChoice, 'auto');
    assert.deepStrictEqual(receivedOptions.responseFormat, { type: 'json_object' });
  });

  it('streamText 应透传完整聊天参数', async () => {
    let receivedOptions;
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: (modelCode) => ({ modelCode }),
        }),
      },
      ai: {
        streamText: async (options) => {
          receivedOptions = options;
          return { textStream: ['ok'] };
        },
      },
    });
    const mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-stream-full-params',
      name: 'OpenAI',
      key: 'openai-stream-full-params',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'model-stream-full-params',
      channel_id: 'ch-stream-full-params',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_cost: '0',
      output_cost: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        max_tokens: 256,
        top_p: 0.8,
        frequency_penalty: 0.3,
        presence_penalty: 0.4,
        stop: ['END'],
        seed: 99,
        tool_choice: 'none',
        response_format: { type: 'json_object' },
        extra_body: { openrouter: { transforms: ['middle-out'] } },
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(receivedOptions.maxTokens, 256);
    assert.strictEqual(receivedOptions.topP, 0.8);
    assert.strictEqual(receivedOptions.frequencyPenalty, 0.3);
    assert.strictEqual(receivedOptions.presencePenalty, 0.4);
    assert.deepStrictEqual(receivedOptions.stopSequences, ['END']);
    assert.strictEqual(receivedOptions.seed, 99);
    assert.strictEqual(receivedOptions.toolChoice, 'none');
    assert.deepStrictEqual(receivedOptions.responseFormat, { type: 'json_object' });
    mockEnv._clear();
  });

  it('executeAIRequest(embedding) 应透传 embedding 参数', async () => {
    let receivedOptions;
    const app = createApp({
      ai: {
        embed: async (options) => {
          receivedOptions = options;
          return { embedding: [0.1, 0.2], usage: {} };
        },
      },
    });
    await app.executeAIRequest(
      { modelId: 'embedding-model' },
      CALL_TYPES.EMBEDDING,
      {
        input: ['hello', 'world'],
        dimensions: 1024,
        encoding_format: 'float',
        user: 'user-1',
        extra_body: { openai: { dimensions: 1024 } },
      },
    );

    assert.deepStrictEqual(receivedOptions.value, ['hello', 'world']);
    assert.strictEqual(receivedOptions.dimensions, 1024);
    assert.strictEqual(receivedOptions.encodingFormat, 'float');
    assert.strictEqual(receivedOptions.user, 'user-1');
  });
});

describe('mix call_type 兼容', () => {
  function seedMixModelEnv() {
    const mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-mix',
      name: 'OpenAI Mix',
      key: 'openai-mix',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-14T00:00:00Z',
      updated_at: '2026-04-14T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'model-mix',
      channel_id: 'ch-mix',
      code: 'gpt-4o-mix',
      name: 'gpt-4o-mix',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.MIX,
      capabilities: JSON.stringify([CALL_TYPES.CHAT, CALL_TYPES.IMAGE_GEN, CALL_TYPES.AUDIO_GEN, CALL_TYPES.VIDEO_GEN]),
      input_cost: '0',
      output_cost: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-14T00:00:00Z',
      headers: '{}',
    });
    return mockEnv;
  }

  it('POST /v1/chat/completions 使用 mix 模型时应返回 chat 格式', async () => {
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async () => ({ text: 'hello from mix', usage: {} }),
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-4o-mix', messages: [{ role: 'user', content: 'hello' }] },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.object, 'chat.completion');
    assert.strictEqual(data.choices[0].message.content, 'hello from mix');
  });

  it('POST /v1/images/generations 使用 mix 模型时应从 chat 文本提取图片', async () => {
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async () => ({ text: 'image data:data:image/png;base64,aGVsbG8=', usage: {} }),
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_IMAGES,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-4o-mix', prompt: 'draw' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.deepStrictEqual(data.data, [{ url: 'aGVsbG8=' }]);
  });

  it('POST /v1/audio/speech 使用 mix 模型时应从 chat 文本提取音频', async () => {
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async () => ({ text: 'audio data:audio/mpeg;base64,aGVsbG8=', usage: {} }),
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_AUDIO,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-4o-mix', input: 'say hi' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(response.headers.get('content-type'), 'application/json');
    assert.strictEqual(Array.isArray(data.data), true);
    assert.strictEqual(data.data.length, 1);
    assert.strictEqual(typeof data.data[0].url, 'object');
    assert.strictEqual(data.data[0].url[0], 104);
    assert.strictEqual(data.data[0].url[1], 101);
    assert.strictEqual(data.data[0].url[2], 108);
    assert.strictEqual(data.data[0].url[3], 108);
    assert.strictEqual(data.data[0].url[4], 111);
  });

  it('POST /v1/video/generations 使用 mix 模型时应从 chat 文本提取视频', async () => {
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async () => ({ text: 'video data:video/mp4;base64,aGVsbG8=', usage: {} }),
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_VIDEO,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-4o-mix', prompt: 'video' },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.deepStrictEqual(data.data, [{ url: 'aGVsbG8=' }]);
  });
});

describe('数据库字段升级: channels.weight + 双向成本字段', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = createApp({
      now: () => new Date('2026-04-15T00:00:00.000Z'),
      uuid: (() => {
        let idx = 0;
        return () => `uuid-${++idx}`;
      })(),
      providers: {
        createOpenAI: () => ({ chat: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        generateText: async () => ({
          text: 'ok',
          usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 },
        }),
      },
    });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('渠道权重应参与模型排序（channels.weight 更高者优先）', async () => {
    mockEnv._addChannel({
      id: 'ch-low',
      name: 'Low Channel',
      key: 'low-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-low',
      base_url: '',
      weight: 0.1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addChannel({
      id: 'ch-high',
      name: 'High Channel',
      key: 'high-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-high',
      base_url: '',
      weight: 9.9,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-low',
      channel_id: 'ch-low',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_cost: '1',
      output_cost: '1',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-15T00:00:00.000Z',
      headers: '{}',
    });
    mockEnv._addModel({
      id: 'model-high',
      channel_id: 'ch-high',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_cost: '1',
      output_cost: '1',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-15T00:00:00.000Z',
      headers: '{}',
    });

    const result = await app.selectModels('gpt-4o', CALL_TYPES.CHAT, mockEnv);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].channel.id, 'ch-high');
    assert.strictEqual(result[1].channel.id, 'ch-low');
  });

  it('创建渠道时应写入模型 input_cost/output_cost', async () => {
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.API_CHANNEL,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        name: 'Cost Channel',
        key: 'cost-channel',
        provider: PROVIDERS.OPENAI,
        apiKey: 'sk-test',
        baseURL: '',
        weight: 3.2,
        models: [{
          code: 'gpt-4o-mini',
          name: 'gpt-4o-mini',
          callType: CALL_TYPES.CHAT,
          capabilities: [CALL_TYPES.CHAT],
          inputCost: '0',
          outputCost: '0.6/M',
          weight: 1,
        }],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.CREATED);

    const createdChannel = Array.from(mockEnv._channels.values()).find((it) => it.key === 'cost-channel');
    const createdModel = Array.from(mockEnv._models.values()).find((it) => it.code === 'gpt-4o-mini');
    assert.ok(createdChannel);
    assert.strictEqual(createdChannel.weight, 3.2);
    assert.ok(createdModel);
    assert.strictEqual(createdModel.input_cost, '0');
    assert.strictEqual(createdModel.output_cost, '0.6/M');
  });

  it('请求成功日志应写入 input_cost/output_cost', async () => {
    mockEnv._addChannel({
      id: 'ch-log',
      name: 'Log Channel',
      key: 'log-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-log',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-log',
      channel_id: 'ch-log',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_cost: '0',
      output_cost: '1.2/M',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-15T00:00:00.000Z',
      headers: '{}',
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.ok(mockEnv._logs.length > 0);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.input_cost, '0');
    assert.strictEqual(latestLog.output_cost, '0.0000084');
  });

  it('请求成功日志应按 token 与 /M 费率计算真实成本', async () => {
    mockEnv._addChannel({
      id: 'ch-real-cost',
      name: 'Real Cost Channel',
      key: 'real-cost-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-real-cost',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-real-cost',
      channel_id: 'ch-real-cost',
      code: 'gpt-4o-cost',
      name: 'gpt-4o-cost',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_cost: '5/M',
      output_cost: '10/M',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-15T00:00:00.000Z',
      headers: '{}',
    });

    app = createApp({
      now: () => new Date('2026-04-15T00:00:00.000Z'),
      uuid: (() => {
        let idx = 0;
        return () => `uuid-real-cost-${++idx}`;
      })(),
      providers: {
        createOpenAI: () => ({ chat: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        generateText: async () => ({
          text: 'ok',
          usage: { promptTokens: 100000, completionTokens: 100000, totalTokens: 200000 },
        }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-cost',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.ok(mockEnv._logs.length > 0);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.input_cost, '0.5');
    assert.strictEqual(latestLog.output_cost, '1');
  });
});

describe('自动迁移: initializeDatabase', () => {
  it('应在缺失列时自动补列并执行 cost 回填 SQL', async () => {
    const executedSql = [];
    const env = {
      DB: {
        prepare: (sql) => ({
          bind: function (...args) {
            this._bindings = args;
            return this;
          },
          run: async function () {
            executedSql.push(sql);
            return { success: true };
          },
          all: async function () {
            executedSql.push(sql);
            if (String(sql).includes('PRAGMA table_info(channels)')) {
              return { results: [{ name: 'id' }, { name: 'name' }] };
            }
            if (String(sql).includes('PRAGMA table_info(channel_models)')) {
              return { results: [{ name: 'id' }, { name: 'cost' }] };
            }
            if (String(sql).includes('PRAGMA table_info(request_logs)')) {
              return { results: [{ name: 'id' }, { name: 'status' }] };
            }
            return { results: [] };
          },
        }),
      },
    };

    await createApp().initializeDatabase(env);

    assert.ok(executedSql.some((sql) => String(sql).includes('ALTER TABLE channels ADD COLUMN weight')));
    assert.ok(executedSql.some((sql) => String(sql).includes('ALTER TABLE channel_models ADD COLUMN input_cost')));
    assert.ok(executedSql.some((sql) => String(sql).includes('ALTER TABLE channel_models ADD COLUMN output_cost')));
    assert.ok(executedSql.some((sql) => String(sql).includes('ALTER TABLE request_logs ADD COLUMN input_cost')));
    assert.ok(executedSql.some((sql) => String(sql).includes('ALTER TABLE request_logs ADD COLUMN output_cost')));
    assert.ok(executedSql.some((sql) => String(sql).includes('UPDATE channel_models') && String(sql).includes('COALESCE(NULLIF(cost')));
  });
});
