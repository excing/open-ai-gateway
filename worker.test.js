import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { getMp3Duration, getMp4Duration } from './media-utils.js';
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
              const [
                id,
                channelId,
                code,
                name,
                desc,
                aliases,
                callType,
                capabilities,
                inputPrice,
                outputPrice,
                status,
                weight,
                avgLatencyMs = 0,
                successRate = 1,
                errorRate = 0,
                consecutiveFailures = 0,
                cooldownUntil = null,
                requestCount = 0,
                inputUsage = 0,
                outpuUsage = 0,
                totalCost = 0,
                lastUpdated = new Date().toISOString(),
                headers = '{}',
              ] = bindings;
              models.set(id, { 
                id, channel_id: channelId, code, name, desc, aliases, call_type: callType, 
                capabilities, input_price: inputPrice, output_price: outputPrice, status, weight, avg_latency_ms: avgLatencyMs, success_rate: successRate, error_rate: errorRate,
                consecutive_failures: consecutiveFailures, cooldown_until: cooldownUntil, request_count: requestCount, input_usage: inputUsage, outpu_usage: outpuUsage, total_cost: totalCost, last_updated: lastUpdated, headers
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
            if (normalizedSql.includes('delete from channel_models where code')) {
              const [code, channelId] = bindings;
              let deleted = 0;
              for (const [id, model] of models.entries()) {
                const codeMatched = model.code === code;
                const channelMatched = channelId ? model.channel_id === channelId : true;
                if (codeMatched && channelMatched) {
                  models.delete(id);
                  deleted += 1;
                }
              }
              return { success: true, meta: { changes: deleted } };
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
              const sqlSegments = normalizedSql.split(' where ');
              const setClauseRaw = sqlSegments[0].replace('update channel_models set', '').trim();
              const setFields = setClauseRaw.split(',').map((item) => item.trim().split('=')[0].trim());
              const setValues = bindings.slice(0, setFields.length);
              const updates = Object.fromEntries(setFields.map((field, index) => [field, setValues[index]]));

              const whereBindings = bindings.slice(setFields.length);
              let updated = 0;
              for (const model of models.values()) {
                let matched = false;
                if (normalizedSql.includes('where id')) {
                  matched = model.id === whereBindings[0];
                } else if (normalizedSql.includes('where code')) {
                  const [code, channelId] = whereBindings;
                  matched = model.code === code && (!channelId || model.channel_id === channelId);
                }
                if (!matched) continue;
                Object.assign(model, updates);
                updated += 1;
              }
              return { success: true, meta: { changes: updated } };
            }
            
            // INSERT log
            if (normalizedSql.includes('insert into request_logs')) {
              logs.push({
                id: bindings[0],
                channel_id: bindings[1],
                channel_name: bindings[2],
                model_id: bindings[3],
                input_quantity: bindings[10],
                output_quantity: bindings[11],
                input_price: bindings[12],
                output_price: bindings[13],
                input_cost: bindings[14],
                output_cost: bindings[15],
                total_cost: bindings[16],
                created_at: bindings[17],
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
            if (normalizedSql.includes('select * from channel_models where code')) {
              const [code, channelId] = bindings;
              const results = Array.from(models.values()).filter((model) => model.code === code && (!channelId || model.channel_id === channelId));
              return { results };
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
              const aliasLike = String(bindings[1] || '');
              const aliasQuoted = aliasLike.replaceAll('%', '').replace(/^"+|"+$/g, '');
              const results = Array.from(models.values())
                .filter((m) => {
                  if (m.code === modelIdentifier) return true;
                  try {
                    const aliases = JSON.parse(m.aliases || '[]');
                    return Array.isArray(aliases) && aliases.includes(aliasQuoted);
                  } catch {
                    return false;
                  }
                })
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
            if (normalizedSql.includes('from channel_models cm join channels c on cm.channel_id = c.id')) {
              const results = Array.from(models.values()).map(m => {
                const ch = channels.get(m.channel_id);
                return { ...m, channel_name: ch?.name || 'unknown', provider: ch?.provider || '' };
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
            if (normalizedSql.includes('select * from channel_models where code')) {
              const [code, channelId] = bindings;
              return Array.from(models.values()).find((model) => model.code === code && (!channelId || model.channel_id === channelId)) || null;
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
    
    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
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

describe('API: GET /status - 返回状态列表', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: () => 'test-uuid-status',
    });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('应返回 provider 和 call_type 字段', async () => {
    const channelId = 'status-ch-1';
    mockEnv._addChannel({
      id: channelId,
      name: 'Status Channel',
      key: 'status-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-status',
      base_url: '',
      weight: 1,
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'status-model-1',
      channel_id: channelId,
      code: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 52.1,
      success_rate: 0.999,
      error_rate: 0.001,
      consecutive_failures: 0,
      cooldown_until: null,
      request_count: 42,
      input_usage: 123,
      outpu_usage: 456,
      total_cost: 7890,
      last_updated: '2026-04-12T00:00:00Z',
      headers: '{}',
    });

    const request = createMockRequest({
      method: 'GET',
      pathname: ROUTES.STATUS,
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.ok(Array.isArray(data.models));
    assert.strictEqual(data.models.length, 1);
    assert.strictEqual(data.models[0].provider, PROVIDERS.OPENAI);
    assert.strictEqual(data.models[0].call_type, CALL_TYPES.CHAT);
    assert.strictEqual(data.models[0].request_count, 42);
    assert.strictEqual(data.models[0].input_usage, 123);
    assert.strictEqual(data.models[0].outpu_usage, 456);
    assert.strictEqual(data.models[0].total_cost, 7890);
  });
});

describe('API: GET /v1/models - 模型标识列表（code + alias）', () => {
  it('应把真实 code 与 aliases 作为同级模型项返回', async () => {
    const app = createApp({
      now: () => new Date('2026-04-20T00:00:00Z'),
    });
    const mockEnv = createMockEnv();

    mockEnv._addChannel({
      id: 'ch-v1-models-1',
      name: 'OpenAI Main',
      key: 'openai-main',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      weight: 1,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'm-v1-models-1',
      channel_id: 'ch-v1-models-1',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: JSON.stringify(['my-gpt', 'my-gpt-4o']),
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-20T00:00:00Z',
      headers: '{}',
    });

    const request = createMockRequest({
      method: 'GET',
      pathname: ROUTES.V1_MODELS,
      headers: { authorization: 'Bearer test-admin-key' },
    });
    const response = await app.handleRequest(request, mockEnv);
    const payload = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(payload));
    assert.strictEqual(payload.object, 'list');
    assert.strictEqual(payload.data.length, 3);
    assert.deepStrictEqual(
      payload.data.map((item) => item.id).sort(),
      ['gpt-4o', 'my-gpt', 'my-gpt-4o'],
    );
    mockEnv._clear();
  });

  it('应按最终模型标识去重（含跨渠道重复 alias、alias=code、空 alias）', async () => {
    const app = createApp({
      now: () => new Date('2026-04-20T00:00:00Z'),
    });
    const mockEnv = createMockEnv();

    mockEnv._addChannel({
      id: 'ch-v1-models-a',
      name: 'OpenAI A',
      key: 'openai-a',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test-a',
      base_url: '',
      weight: 1,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });
    mockEnv._addChannel({
      id: 'ch-v1-models-b',
      name: 'OpenAI B',
      key: 'openai-b',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test-b',
      base_url: '',
      weight: 1,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });

    mockEnv._addModel({
      id: 'm-v1-models-a',
      channel_id: 'ch-v1-models-a',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: JSON.stringify(['my-gpt', 'gpt-4o', '   ', '']),
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-20T00:00:00Z',
      headers: '{}',
    });
    mockEnv._addModel({
      id: 'm-v1-models-b',
      channel_id: 'ch-v1-models-b',
      code: 'gpt-4o',
      name: 'gpt-4o mirror',
      desc: '',
      aliases: JSON.stringify(['my-gpt', 'mirror']),
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-20T00:00:00Z',
      headers: '{}',
    });

    const request = createMockRequest({
      method: 'GET',
      pathname: ROUTES.V1_MODELS,
      headers: { authorization: 'Bearer test-admin-key' },
    });
    const response = await app.handleRequest(request, mockEnv);
    const payload = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(payload));
    assert.deepStrictEqual(
      payload.data.map((item) => item.id).sort(),
      ['gpt-4o', 'mirror', 'my-gpt'],
    );
    mockEnv._clear();
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
      input_price: '0',
      output_price: '0',
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
          return { text: 'ok', responses: [{ body: { words: [], duration: 0, language: 'en' } }] };
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

  it('multipart 多个 file 字段时，transcribe 应使用第一个文件', async () => {
    let receivedAudio;
    const firstAudio = new Uint8Array([1, 2, 3]);
    const secondAudio = new Uint8Array([9, 8, 7]);

    app = createApp({
      providers: {
        createOpenAI: () => ({
          transcription: (modelCode) => ({ modelCode }),
        }),
      },
      ai: {
        experimental_transcribe: async ({ audio }) => {
          receivedAudio = audio;
          return { text: 'ok-multi-file', responses: [{ body: { words: [], duration: 0, language: 'en' } }] };
        },
      },
    });

    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('file', new Blob([firstAudio], { type: 'audio/mpeg' }));
    form.append('file', new Blob([secondAudio], { type: 'audio/mpeg' }));

    const request = {
      method: 'POST',
      url: `https://example.com${ROUTES.V1_TRANSCRIBE}`,
      headers: {
        get: (key) => {
          if (String(key).toLowerCase() === HEADERS.CONTENT_TYPE.toLowerCase()) {
            return `${MULTIPART_CONTENT_TYPE}; boundary=----test-boundary`;
          }
          if (String(key).toLowerCase() === HEADERS.AUTHORIZATION.toLowerCase()) {
            return 'Bearer test-admin-key';
          }
          return undefined;
        },
      },
      formData: async () => form,
      json: async () => {
        throw new Error('should not parse json for multipart');
      },
    };

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.text, 'ok-multi-file');
    assert.ok(receivedAudio instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(receivedAudio), [1, 2, 3]);
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

describe('API: PUT /api/channel/:id - models 增量更新（有 id 更新、无 id 创建、非法 id 跳过）', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    app = createApp();
    mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-main',
      name: '主渠道',
      key: 'main-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-main',
      base_url: '',
      weight: 1,
      created_at: '2026-04-25T00:00:00Z',
      updated_at: '2026-04-25T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'm-existing',
      channel_id: 'ch-main',
      code: 'gpt-4o',
      name: 'GPT-4o Old',
      desc: 'old-desc',
      aliases: '["gpt-4o-old"]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      input_price: '10/M',
      output_price: '20/M',
      status: MODEL_STATUS.ACTIVE,
      weight: 3,
      avg_latency_ms: 321,
      success_rate: 0.88,
      error_rate: 0.12,
      consecutive_failures: 2,
      cooldown_until: null,
      request_count: 42,
      input_usage: 1000,
      outpu_usage: 2000,
      total_cost: 3000,
      last_updated: '2026-04-25T00:00:00Z',
      headers: '{"x-test":"1"}',
    });
    mockEnv._addModel({
      id: 'm-untouched',
      channel_id: 'ch-main',
      code: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      request_count: 9,
      input_usage: 90,
      outpu_usage: 180,
      total_cost: 270,
      last_updated: '2026-04-25T00:00:00Z',
      headers: '{}',
    });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('应更新已有模型并保留统计字段，同时创建新模型且不删除未提交模型', async () => {
    const request = createMockRequest({
      method: 'PUT',
      pathname: '/api/channel/ch-main',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        name: '主渠道-更新后',
        models: [
          {
            id: 'm-existing',
            code: 'gpt-4o',
            name: 'GPT-4o New',
            desc: 'new-desc',
            aliases: ['gpt-4o-new'],
            callType: CALL_TYPES.CHAT,
            capabilities: [CALL_TYPES.CHAT],
            inputPrice: '11/M',
            outputPrice: '21/M',
            weight: 5,
            headers: { 'x-test': '2' },
          },
          {
            code: 'gpt-4.1',
            name: 'GPT-4.1',
            desc: 'new-model',
            aliases: ['gpt41'],
            callType: CALL_TYPES.CHAT,
            capabilities: [CALL_TYPES.CHAT],
            inputPrice: '12/M',
            outputPrice: '22/M',
            weight: 2,
            headers: { 'x-new': '1' },
          },
        ],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.model_changes.updated_count, 1);
    assert.strictEqual(data.model_changes.created_count, 1);
    assert.deepStrictEqual(data.model_changes.skipped, []);

    const updated = mockEnv._models.get('m-existing');
    assert.strictEqual(updated.name, 'GPT-4o New');
    assert.strictEqual(updated.desc, 'new-desc');
    assert.strictEqual(updated.input_price, '11/M');
    assert.strictEqual(updated.output_price, '21/M');
    assert.strictEqual(updated.weight, 5);
    assert.strictEqual(updated.request_count, 42);
    assert.strictEqual(updated.input_usage, 1000);
    assert.strictEqual(updated.outpu_usage, 2000);
    assert.strictEqual(updated.total_cost, 3000);
    assert.strictEqual(updated.avg_latency_ms, 321);
    assert.strictEqual(updated.success_rate, 0.88);

    assert.strictEqual(mockEnv._models.has('m-untouched'), true);

    const created = Array.from(mockEnv._models.values()).find((model) => model.code === 'gpt-4.1');
    assert.ok(created);
    assert.strictEqual(created.channel_id, 'ch-main');
    assert.strictEqual(created.request_count, 0);
    assert.strictEqual(created.input_usage, 0);
    assert.strictEqual(created.outpu_usage, 0);
    assert.strictEqual(created.total_cost, 0);
  });

  it('models 中非法 id 应跳过并返回 skipped 原因', async () => {
    const request = createMockRequest({
      method: 'PUT',
      pathname: '/api/channel/ch-main',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        models: [
          {
            id: 'm-not-found',
            code: 'gpt-4o',
            name: 'ignore',
          },
        ],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.model_changes.updated_count, 0);
    assert.strictEqual(data.model_changes.created_count, 0);
    assert.strictEqual(data.model_changes.skipped.length, 1);
    assert.deepStrictEqual(data.model_changes.skipped[0], {
      id: 'm-not-found',
      reason: 'model_not_found',
    });
  });

  it('应支持 deletedModelIds 删除当前渠道下指定模型并返回删除统计', async () => {
    const request = createMockRequest({
      method: 'PUT',
      pathname: '/api/channel/ch-main',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        deletedModelIds: ['m-untouched'],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.model_changes.deleted_count, 1);
    assert.deepStrictEqual(data.model_changes.delete_skipped, []);
    assert.strictEqual(mockEnv._models.has('m-untouched'), false);
    assert.strictEqual(mockEnv._models.has('m-existing'), true);
  });

  it('deletedModelIds 包含不存在或不属于当前渠道模型时应跳过并记录原因', async () => {
    mockEnv._addChannel({
      id: 'ch-other',
      name: '其他渠道',
      key: 'other-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-other',
      base_url: '',
      weight: 1,
      created_at: '2026-04-25T00:00:00Z',
      updated_at: '2026-04-25T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'm-other-channel',
      channel_id: 'ch-other',
      code: 'gpt-4o',
      name: 'other',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      request_count: 0,
      input_usage: 0,
      outpu_usage: 0,
      total_cost: 0,
      last_updated: '2026-04-25T00:00:00Z',
      headers: '{}',
    });

    const request = createMockRequest({
      method: 'PUT',
      pathname: '/api/channel/ch-main',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        deletedModelIds: ['m-not-found', 'm-other-channel'],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.model_changes.deleted_count, 0);
    assert.strictEqual(data.model_changes.delete_skipped.length, 2);
    assert.deepStrictEqual(data.model_changes.delete_skipped, [
      { id: 'm-not-found', reason: 'model_not_found' },
      { id: 'm-other-channel', reason: 'model_not_found' },
    ]);
    assert.strictEqual(mockEnv._models.has('m-existing'), true);
    assert.strictEqual(mockEnv._models.has('m-untouched'), true);
    assert.strictEqual(mockEnv._models.has('m-other-channel'), true);
  });
});

describe('API: PUT/DELETE /api/model/:id - 同名批量与按渠道操作', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    app = createApp();
    mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-1',
      name: '渠道一',
      key: 'channel-1',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-1',
      base_url: '',
      weight: 1,
      created_at: '2026-04-25T00:00:00Z',
      updated_at: '2026-04-25T00:00:00Z',
    });
    mockEnv._addChannel({
      id: 'ch-2',
      name: '渠道二',
      key: 'channel-2',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-2',
      base_url: '',
      weight: 1,
      created_at: '2026-04-25T00:00:00Z',
      updated_at: '2026-04-25T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'm-1',
      channel_id: 'ch-1',
      code: 'gpt-4o',
      name: 'GPT-4o A',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-25T00:00:00Z',
      headers: '{}',
    });
    mockEnv._addModel({
      id: 'm-2',
      channel_id: 'ch-2',
      code: 'gpt-4o',
      name: 'GPT-4o B',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: '["chat"]',
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-25T00:00:00Z',
      headers: '{}',
    });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('PUT sync_scope=by_code 应更新同 code 的全部模型', async () => {
    const request = createMockRequest({
      method: 'PUT',
      pathname: '/api/model/m-1?sync_scope=by_code',
      headers: { authorization: 'Bearer test-admin-key' },
      body: { status: MODEL_STATUS.DISABLE },
    });
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(mockEnv._models.get('m-1').status, MODEL_STATUS.DISABLE);
    assert.strictEqual(mockEnv._models.get('m-2').status, MODEL_STATUS.DISABLE);
  });

  it('PUT sync_scope=by_code + channel_id 仅更新指定渠道模型', async () => {
    const request = createMockRequest({
      method: 'PUT',
      pathname: '/api/model/m-1?sync_scope=by_code&channel_id=ch-1',
      headers: { authorization: 'Bearer test-admin-key' },
      body: { weight: 9 },
    });
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(mockEnv._models.get('m-1').weight, 9);
    assert.strictEqual(mockEnv._models.get('m-2').weight, 1);
  });

  it('DELETE sync_scope=by_code + channel_id 仅删除指定渠道模型', async () => {
    const request = createMockRequest({
      method: 'DELETE',
      pathname: '/api/model/m-1?sync_scope=by_code&channel_id=ch-1',
      headers: { authorization: 'Bearer test-admin-key' },
    });
    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(mockEnv._models.has('m-1'), false);
    assert.strictEqual(mockEnv._models.has('m-2'), true);
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
  let originalFetch;

  beforeEach(() => {
    mockEnv = createMockEnv();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input?.url || input?.toString?.() || '';
      if (String(target).includes('https://example.com/image.jpg')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (typeof originalFetch === 'function') {
        return originalFetch(input, init);
      }
      return new Response('not found', { status: 404 });
    };
  });

  afterEach(() => {
    mockEnv._clear();
    globalThis.fetch = originalFetch;
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

describe('Google Translate: 仅 chat 与语音生成且模型受限', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('google-translate 的 chat 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/translate_a/single'));
        assert.ok(target.includes('client=gtx'));
        assert.ok(target.includes('q='));
        assert.strictEqual(options.method, 'GET');
        return new Response(JSON.stringify({ sentences: [{ trans: 'OK' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'google-translate',
        apiKey: 'not-required',
        baseURL: 'https://translate.googleapis.com',
        model: 'google-translate',
        callType: CALL_TYPES.CHAT,
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

  it('google-translate 的 audio_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/translate_tts'));
        assert.ok(target.includes('client=tw-ob'));
        assert.ok(target.includes('tl=en'));
        assert.ok(target.includes('q=test'));
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
        provider: 'google-translate',
        apiKey: 'not-required',
        baseURL: 'https://translate.googleapis.com',
        model: 'google-tts',
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

  it('google-translate 的 chat 非白名单模型应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'google-translate',
        apiKey: 'not-required',
        baseURL: 'https://translate.googleapis.com',
        model: 'not-supported-model',
        callType: CALL_TYPES.CHAT,
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

  it('google-translate 的 embedding 模型检测应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'google-translate',
        apiKey: 'not-required',
        baseURL: 'https://translate.googleapis.com',
        model: 'google-translate',
        callType: CALL_TYPES.EMBEDDING,
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

describe('Youdao: 仅 chat 与语音生成且模型受限', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('youdao 的 chat 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/jsonapi_s'));
        assert.ok(target.includes('doctype=json'));
        assert.ok(target.includes('jsonversion=4'));
        assert.strictEqual(options.method, 'POST');
        const body = String(options.body || '');
        assert.ok(body.includes('q='));
        assert.ok(body.includes('le=en'));
        assert.ok(body.includes('client=web'));
        assert.ok(body.includes('keyfrom=webdict'));
        return new Response(JSON.stringify({ ec: { word: [{ trs: [{ tr: [{ l: { i: ['test'] } }] }] }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'youdao',
        apiKey: 'not-required',
        baseURL: 'https://dict.youdao.com',
        model: 'youdao-dict',
        callType: CALL_TYPES.CHAT,
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

  it('youdao 的 audio_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/dictvoice'));
        assert.ok(target.includes('audio=test'));
        assert.ok(target.includes('type=1'));
        assert.strictEqual(options.method, 'GET');
        return new Response(new Uint8Array([1, 2, 3]), {
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
        provider: 'youdao',
        apiKey: 'not-required',
        baseURL: 'https://dict.youdao.com',
        model: 'youdao-dictvoice',
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

  it('youdao 的 chat 非白名单模型应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'youdao',
        apiKey: 'not-required',
        baseURL: 'https://dict.youdao.com',
        model: 'not-supported-model',
        callType: CALL_TYPES.CHAT,
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

  it('youdao 的 embedding 模型检测应返回不可用', async () => {
    app = createApp();

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'youdao',
        apiKey: 'not-required',
        baseURL: 'https://dict.youdao.com',
        model: 'youdao-dict',
        callType: CALL_TYPES.EMBEDDING,
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

  it('youdao-suggest 的 chat 模型检测应成功并命中 suggest 端点', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/suggest'));
        assert.ok(target.includes('num=5'));
        assert.ok(target.includes('ver=3.0'));
        assert.ok(target.includes('doctype=json'));
        assert.ok(target.includes('q='));
        assert.strictEqual(options.method, 'GET');
        return new Response(JSON.stringify({
          result: { msg: 'success', code: 200 },
          data: { entries: [{ entry: 'dir', explain: 'abbr. director' }], query: 'dir', language: 'en', type: 'dict' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'youdao',
        apiKey: 'not-required',
        baseURL: 'https://dict.youdao.com',
        model: 'youdao-suggest',
        callType: CALL_TYPES.CHAT,
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
});

describe('Iciba: 仅 chat 与语音生成且模型受限', () => {
  let app;
  let mockEnv;
  let originalFetch;

  beforeEach(() => {
    mockEnv = createMockEnv();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input?.url || input?.toString?.() || '';
      if (String(target).includes('http://res.ksyun.iciba.com/resource/amp3/')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      }
      if (typeof originalFetch === 'function') {
        return originalFetch(input, init);
      }
      return new Response('not found', { status: 404 });
    };
  });

  afterEach(() => {
    mockEnv._clear();
    globalThis.fetch = originalFetch;
  });

  it('iciba-dict 的 chat 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('/_next/data/SIgDISbkU9OFnSzS3LWHc/word.json'));
        assert.ok(target.includes('w='));
        assert.strictEqual(options.method, 'GET');
        return new Response(JSON.stringify({ pageProps: { hello: 'world' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'iciba',
        apiKey: 'not-required',
        baseURL: 'https://www.iciba.com',
        model: 'iciba-dict',
        callType: CALL_TYPES.CHAT,
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

  it('iciba-suggest 的 chat 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        assert.ok(target.includes('dict.iciba.com/dictionary/word/suggestion'));
        assert.ok(target.includes('word='));
        assert.ok(target.includes('nums=5'));
        assert.strictEqual(options.method, 'GET');
        return new Response(JSON.stringify({
          status: 1,
          message: [{ key: 'live', paraphrase: 'adj.活的', value: 0, means: [] }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'iciba',
        apiKey: 'not-required',
        baseURL: 'https://www.iciba.com',
        model: 'iciba-suggest',
        callType: CALL_TYPES.CHAT,
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

  it('iciba-dictvoice 的 audio_gen 模型检测应成功', async () => {
    app = createApp({
      fetch: async (url, options) => {
        const target = url.toString();
        if (target.includes('res.ksyun.iciba.com/resource/amp3')) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' },
          });
        }
        assert.ok(target.includes('/_next/data/SIgDISbkU9OFnSzS3LWHc/word.json'));
        assert.ok(target.includes('w=test'));
        assert.strictEqual(options.method, 'GET');
        return new Response(JSON.stringify({
          pageProps: {
            initialReduxState: {
              word: {
                wordInfo: {
                  baesInfo: {
                    symbols: [{
                      ph_en_mp3_bk: 'http://res.ksyun.iciba.com/resource/amp3/oxford/0/26/db/26dbb1063da50734e15c57c9995da7e9.mp3',
                      ph_am_mp3_bk: 'http://res.ksyun.iciba.com/resource/amp3/1/0/1c/b2/1cb251ec0d568de6a929b520c4aed8d1.mp3',
                      ph_tts_mp3_bk: 'http://res-tts.ksyun.iciba.com/1/c/b/1cb251ec0d568de6a929b520c4aed8d1.mp3',
                    }],
                  },
                },
              },
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: '/api/model/check',
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        provider: 'iciba',
        apiKey: 'not-required',
        baseURL: 'https://www.iciba.com',
        model: 'iciba-dictvoice',
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
      input_price: '0',
      output_price: '0',
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
    assert.deepStrictEqual(Object.keys(receivedOptions.tools || {}), ['get_weather']);
    assert.strictEqual(receivedOptions.toolChoice, 'auto');
    assert.deepStrictEqual(receivedOptions.responseFormat, { type: 'json_object' });
  });

  it('executeAIRequest(chat) 应将 OpenAI tool_choice.function 映射为 AI SDK tool 选择', async () => {
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
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_current_weather',
              description: 'Get the current weather in a given location',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                },
                required: ['location'],
              },
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'get_current_weather' },
        },
      },
    );

    assert.deepStrictEqual(Object.keys(receivedOptions.tools || {}), ['get_current_weather']);
    assert.deepStrictEqual(receivedOptions.toolChoice, { type: 'tool', toolName: 'get_current_weather' });
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
      input_price: '0',
      output_price: '0',
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

  it('POST /v1/chat/completions 使用模型别名应命中真实模型', async () => {
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: (modelCode) => ({ modelCode }),
        }),
      },
      ai: {
        generateText: async () => ({ text: 'alias matched', usage: {} }),
      },
    });
    const mockEnv = createMockEnv();
    mockEnv._addChannel({
      id: 'ch-alias-match',
      name: 'OpenAI Alias',
      key: 'openai-alias-match',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      created_at: '2026-04-15T00:00:00Z',
      updated_at: '2026-04-15T00:00:00Z',
    });
    mockEnv._addModel({
      id: 'model-alias-match',
      channel_id: 'ch-alias-match',
      code: 'gpt-4o',
      name: 'gpt-4o',
      desc: '',
      aliases: JSON.stringify(['my-gpt']),
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '0',
      output_price: '0',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-15T00:00:00Z',
      headers: '{}',
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'my-gpt',
        messages: [{ role: 'user', content: 'hello alias' }],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.choices[0].message.content, 'alias matched');
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
      input_price: '0',
      output_price: '0',
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
    assert.deepStrictEqual(data.data, [{ b64_json: 'aGVsbG8=' }]);
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
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
    const audio = new Uint8Array(await response.arrayBuffer());
    assert.deepStrictEqual(Array.from(audio), [104, 101, 108, 108, 111]);
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
    assert.deepStrictEqual(data.data, [{ b64_json: 'aGVsbG8=' }]);
  });

  it('POST /v1/images/generations 使用 mix 模型时应将接口专属参数拼接进 messages', async () => {
    let receivedOptions;
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'image data:data:image/png;base64,aGVsbG8=', usage: {} };
        },
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_IMAGES,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-mix',
        prompt: 'draw a fox',
        n: 2,
        size: '1024x1024',
        aspect_ratio: '1:1',
        response_format: 'b64_json',
      },
    });

    await app.handleRequest(request, mockEnv);
    assert.strictEqual(Array.isArray(receivedOptions.messages), true);
    const contextMessage = receivedOptions.messages.at(-1);
    assert.strictEqual(contextMessage.role, 'user');
    const contextText = contextMessage.content[0].text;
    assert.strictEqual(contextText.includes('"count":2'), true);
    assert.strictEqual(contextText.includes('"size":"1024x1024"'), true);
    assert.strictEqual(contextText.includes('"aspect_ratio":"1:1"'), true);
    assert.strictEqual(contextText.includes('"response_format":"b64_json"'), true);
  });

  it('POST /v1/audio/speech 使用 mix 模型时应将 audio 参数拼接进 messages 且 file 单独注入', async () => {
    let receivedOptions;
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'audio data:audio/mpeg;base64,aGVsbG8=', usage: {} };
        },
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_AUDIO,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-mix',
        input: 'say hi',
        voice: 'alloy',
        speed: 1.1,
        format: 'mp3',
        file: 'data:audio/mpeg;base64,AAAA',
      },
    });

    await app.handleRequest(request, mockEnv);
    assert.strictEqual(Array.isArray(receivedOptions.messages), true);
    assert.strictEqual(receivedOptions.messages.length >= 1, true);
    const fileMessage = receivedOptions.messages.at(-1);
    assert.strictEqual(fileMessage.role, 'user');
    const contextText = fileMessage.content[0].text;
    assert.strictEqual(fileMessage.content[1].type, 'file');
    assert.strictEqual(fileMessage.content[1].data, 'data:audio/mpeg;base64,AAAA');
    assert.strictEqual(fileMessage.content[1].mediaType, 'application/octet-stream');
    assert.strictEqual(contextText.includes('"voice":"alloy"'), true);
    assert.strictEqual(contextText.includes('"speed":1.1'), true);
    assert.strictEqual(contextText.includes('"output_format":"mp3"'), true);
  });

  it('POST /v1/audio/speech multipart 传入文件时，mix 消息中的 file.data 应为 Uint8Array', async () => {
    let receivedOptions;
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'audio data:audio/mpeg;base64,aGVsbG8=', usage: {} };
        },
      },
    });
    const mockEnv = seedMixModelEnv();
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_AUDIO,
      headers: {
        authorization: 'Bearer test-admin-key',
        [HEADERS.CONTENT_TYPE.toLowerCase()]: `${MULTIPART_CONTENT_TYPE}; boundary=----test-boundary`,
      },
      body: {
        model: 'gpt-4o-mix',
        input: 'say hi',
        file: new Blob([new Uint8Array([65, 66, 67])], { type: 'audio/mpeg' }),
      },
    });

    await app.handleRequest(request, mockEnv);
    const fileMessage = receivedOptions.messages.at(-1);
    assert.strictEqual(fileMessage.role, 'user');
    assert.strictEqual(Array.isArray(fileMessage.content), true);
    assert.strictEqual(fileMessage.content[0].type, 'text');
    assert.strictEqual(fileMessage.content[1].type, 'file');
    assert.ok(fileMessage.content[1].data instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(fileMessage.content[1].data), [65, 66, 67]);
  });

  it('POST /v1/audio/speech multipart 多文件并跨字段传递时，mix 应按顺序注入多个 file content', async () => {
    let receivedOptions;
    const app = createApp({
      providers: {
        createOpenAI: () => ({
          chat: () => ({ modelCode: 'gpt-4o-mix' }),
        }),
      },
      ai: {
        generateText: async (options) => {
          receivedOptions = options;
          return { text: 'ok', usage: {} };
        },
      },
    });
    const mockEnv = seedMixModelEnv();

    const form = new FormData();
    form.append('model', 'gpt-4o-mix');
    form.append('input', 'say hi');
    form.append('file', new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
    form.append('file', new Blob([new Uint8Array([2])], { type: 'audio/mpeg' }));
    form.append('image', new Blob([new Uint8Array([3])], { type: 'image/png' }));
    form.append('input_image', new Blob([new Uint8Array([4])], { type: 'image/png' }));
    form.append('inputImage', new Blob([new Uint8Array([5])], { type: 'image/png' }));

    const request = {
      method: 'POST',
      url: `https://example.com${ROUTES.V1_AUDIO}`,
      headers: {
        get: (key) => {
          if (String(key).toLowerCase() === HEADERS.CONTENT_TYPE.toLowerCase()) {
            return `${MULTIPART_CONTENT_TYPE}; boundary=----test-boundary`;
          }
          if (String(key).toLowerCase() === HEADERS.AUTHORIZATION.toLowerCase()) {
            return 'Bearer test-admin-key';
          }
          return undefined;
        },
      },
      formData: async () => form,
      json: async () => {
        throw new Error('should not parse json for multipart');
      },
    };

    await app.handleRequest(request, mockEnv);
    const userMessage = receivedOptions.messages.at(-1);
    assert.strictEqual(userMessage.role, 'user');
    const fileContents = userMessage.content.filter((item) => item.type === 'file');
    assert.strictEqual(fileContents.length, 5);
    assert.deepStrictEqual(Array.from(fileContents[0].data), [1]);
    assert.deepStrictEqual(Array.from(fileContents[1].data), [2]);
    assert.deepStrictEqual(Array.from(fileContents[2].data), [3]);
    assert.deepStrictEqual(Array.from(fileContents[3].data), [4]);
    assert.deepStrictEqual(Array.from(fileContents[4].data), [5]);
  });
});

describe('openai-compatible provider', () => {
  it('应使用 createOpenAICompatible 实例化 chat 模型', () => {
    let openAICalled = false;
    let compatibleCalled = false;
    let capturedConfig;
    const app = createApp({
      providers: {
        createOpenAI: () => {
          openAICalled = true;
          return { chat: () => ({ source: 'openai' }) };
        },
        createOpenAICompatible: (config) => {
          compatibleCalled = true;
          capturedConfig = config;
          return { chatModel: () => ({ source: 'openai-compatible' }) };
        },
      },
    });

    const model = app.instantiateLanguageModel(
      'Compatible Channel',
      'https://compatible.example.com/v1',
      'sk-compatible',
      { 'x-custom': '1' },
      PROVIDERS.OPENAI_COMPATIBLE,
      CALL_TYPES.CHAT,
      'gpt-4o-mini',
      createMockEnv(),
    );

    assert.strictEqual(openAICalled, false);
    assert.strictEqual(compatibleCalled, true);
    assert.strictEqual(model.source, 'openai-compatible');
    assert.strictEqual(capturedConfig.baseURL, 'https://compatible.example.com/v1');
    assert.strictEqual(capturedConfig.apiKey, 'sk-compatible');
    assert.deepStrictEqual(capturedConfig.headers, { 'x-custom': '1' });
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
      input_price: '1',
      output_price: '1',
      status: MODEL_STATUS.ACTIVE,
      weight: 1,
      avg_latency_ms: 0,
      success_rate: 1,
      error_rate: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      last_updated: '2026-04-15T00:00:00.000Z',
      input_usage: 0,
      outpu_usage: 0,
      total_cost: 0,
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
      input_price: '1',
      output_price: '1',
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

  it('创建渠道时应写入模型 input_price/output_price', async () => {
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
          inputPrice: '0',
          outputPrice: '0.6/M',
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
    assert.strictEqual(createdModel.input_price, '0');
    assert.strictEqual(createdModel.output_price, '0.6/M');
  });

  it('统一日志函数: success 应写入日志并按 usage 计算成本', async () => {
    mockEnv._addChannel({
      id: 'ch-unified-success',
      name: 'Unified Success Channel',
      key: 'unified-success-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-unified-success',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-unified-success',
      channel_id: 'ch-unified-success',
      code: 'gpt-4o-unified-success',
      name: 'gpt-4o-unified-success',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '2/M',
      output_price: '3/M',
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
      providers: {
        createOpenAI: () => ({ chat: () => ({ modelCode: 'gpt-4o-unified-success' }) }),
      },
      ai: {
        generateText: async () => ({
          text: 'ok',
          usage: { promptTokens: 500000, completionTokens: 1000000, totalTokens: 1500000 },
        }),
      },
    });
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-unified-success',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);

    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.channel_id, 'ch-unified-success');
    assert.strictEqual(latestLog.model_id, 'model-unified-success');
    assert.strictEqual(latestLog.input_quantity, 500000);
    assert.strictEqual(latestLog.output_quantity, 1000000);
    assert.strictEqual(latestLog.input_cost, 1000000000);
    assert.strictEqual(latestLog.output_cost, 3000000000);
    assert.strictEqual(latestLog.total_cost, 4000000000);
    assert.strictEqual(mockEnv._models.get('model-unified-success').request_count, 1);
    assert.strictEqual(mockEnv._models.get('model-unified-success').input_usage, 500000);
    assert.strictEqual(mockEnv._models.get('model-unified-success').outpu_usage, 1000000);
    assert.strictEqual(mockEnv._models.get('model-unified-success').total_cost, 4000000000);
  });

  it('统一日志函数: error 在缺省 usage 时应写入 0 用量与 0 成本', async () => {
    mockEnv._addChannel({
      id: 'ch-unified-error',
      name: 'Unified Error Channel',
      key: 'unified-error-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-unified-error',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-unified-error',
      channel_id: 'ch-unified-error',
      code: 'gpt-4o-unified-error',
      name: 'gpt-4o-unified-error',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '2/req',
      output_price: '8/M',
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
      providers: {
        createOpenAI: () => ({ chat: () => ({ modelCode: 'gpt-4o-unified-error' }) }),
      },
      ai: {
        generateText: async () => {
          throw new Error('upstream failed');
        },
      },
    });
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-unified-error',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.INTERNAL_ERROR);

    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.channel_id, 'ch-unified-error');
    assert.strictEqual(latestLog.model_id, 'model-unified-error');
    assert.strictEqual(latestLog.input_quantity, 0);
    assert.strictEqual(latestLog.output_quantity, 0);
    assert.strictEqual(latestLog.input_price, '0');
    assert.strictEqual(latestLog.output_price, '0');
    assert.strictEqual(latestLog.input_cost, 0);
    assert.strictEqual(latestLog.output_cost, 0);
    assert.strictEqual(latestLog.total_cost, 0);
    assert.strictEqual(mockEnv._models.get('model-unified-error').request_count, 1);
  });

  it('请求成功日志应写入 input_price/output_price', async () => {
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
      input_price: '0',
      output_price: '1.2/M',
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
    assert.strictEqual(latestLog.input_price, '0');
    assert.strictEqual(latestLog.output_price, '1.2/M');
    assert.strictEqual(latestLog.input_cost, 0);
    assert.strictEqual(latestLog.output_cost, 8400);
    assert.strictEqual(latestLog.total_cost, 8400);
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
      input_price: '5/M',
      output_price: '10/M',
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
    assert.strictEqual(latestLog.input_quantity, 100000);
    assert.strictEqual(latestLog.output_quantity, 100000);
    assert.strictEqual(latestLog.input_price, '5/M');
    assert.strictEqual(latestLog.output_price, '10/M');
    assert.strictEqual(latestLog.input_cost, 500000000);
    assert.strictEqual(latestLog.output_cost, 1000000000);
    assert.strictEqual(latestLog.total_cost, 1500000000);
  });

  it('应优先读取 AI SDK v6 usage.inputTokens/outputTokens', async () => {
    mockEnv._addChannel({
      id: 'ch-v6-usage',
      name: 'V6 Usage Channel',
      key: 'v6-usage-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-v6-usage',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-v6-usage',
      channel_id: 'ch-v6-usage',
      code: 'gpt-4o-v6-usage',
      name: 'gpt-4o-v6-usage',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '5/M',
      output_price: '10/M',
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
      providers: {
        createOpenAI: () => ({ chat: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        generateText: async () => ({
          text: 'ok',
          usage: { inputTokens: 200000, outputTokens: 300000, totalTokens: 500000 },
        }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-v6-usage',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const responseData = await response.json();
    assert.strictEqual(responseData.usage.prompt_tokens, 200000);
    assert.strictEqual(responseData.usage.completion_tokens, 300000);
    assert.strictEqual(responseData.usage.total_tokens, 500000);

    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.input_quantity, 200000);
    assert.strictEqual(latestLog.output_quantity, 300000);
    assert.strictEqual(latestLog.input_price, '5/M');
    assert.strictEqual(latestLog.output_price, '10/M');
    assert.strictEqual(latestLog.input_cost, 1000000000);
    assert.strictEqual(latestLog.output_cost, 3000000000);
    assert.strictEqual(latestLog.total_cost, 4000000000);
  });

  it('stream 回退错误日志应记录为 0 成本错误日志', async () => {
    mockEnv._addChannel({
      id: 'ch-stream-cost',
      name: 'Stream Cost Channel',
      key: 'stream-cost-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-stream-cost',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-stream-cost',
      channel_id: 'ch-stream-cost',
      code: 'gpt-4o-stream-cost',
      name: 'gpt-4o-stream-cost',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.CHAT,
      capabilities: JSON.stringify([CALL_TYPES.CHAT]),
      input_price: '2/req',
      output_price: '10/M',
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
      providers: {
        createOpenAI: () => ({ chat: () => ({ modelCode: 'gpt-4o-stream-cost' }) }),
      },
      createFallback: ({ onError }) => ({
        modelId: 'gpt-4o-stream-cost',
        async doGenerate() {
          await onError(new Error('stream fallback error'), 'gpt-4o-stream-cost');
          return { textStream: [], warnings: [] };
        },
      }),
      ai: {
        streamText: async ({ model, onFinish }) => {
          if (model?.doGenerate) {
            await model.doGenerate();
          }
          if (onFinish) {
            await onFinish({ usage: { promptTokens: 0, completionTokens: 0 } });
          }
          return { textStream: [] };
        },
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_CHAT,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-4o-stream-cost',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.ok(mockEnv._logs.length >= 1);
    const errorLog = mockEnv._logs.find((log) => (
      log.model_id === 'model-stream-cost'
      && log.input_price === '0'
      && log.output_price === '0'
      && log.input_cost === 0
      && log.output_cost === 0
      && log.total_cost === 0
    ));
    assert.ok(errorLog);
  });

  it('image_gen 请求应优先按请求输入图片数与输出 images.length 手动统计', async () => {
    mockEnv._addChannel({
      id: 'ch-img-cost',
      name: 'Image Cost Channel',
      key: 'image-cost-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-image-cost',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-img-cost',
      channel_id: 'ch-img-cost',
      code: 'gpt-image-1',
      name: 'gpt-image-1',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.IMAGE_GEN,
      capabilities: JSON.stringify([CALL_TYPES.IMAGE_GEN]),
      input_price: '0',
      output_price: '0.02/img',
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
      providers: {
        createOpenAI: () => ({ image: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        generateImage: async () => ({
          inputImageCount: 99,
          images: [{ base64: 'a' }, { base64: 'b' }, { base64: 'c' }],
        }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_IMAGES,
      headers: { authorization: 'Bearer test-admin-key' },
      body: {
        model: 'gpt-image-1',
        prompt: 'draw',
        n: 3,
        input_images_count: 2,
      },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.output_price, '0.02/img');
    assert.strictEqual(latestLog.input_quantity, 0);
    assert.strictEqual(latestLog.output_quantity, 3);
    assert.strictEqual(latestLog.input_cost, 0);
    assert.strictEqual(latestLog.output_cost, 60000000);
    assert.strictEqual(latestLog.total_cost, 60000000);
  });

  it('audio_gen 请求应优先按输入秒数与音频二进制手动时长统计', async () => {
    mockEnv._addChannel({
      id: 'ch-audio-cost',
      name: 'Audio Cost Channel',
      key: 'audio-cost-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-audio-cost',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-audio-cost',
      channel_id: 'ch-audio-cost',
      code: 'gpt-audio-1',
      name: 'gpt-audio-1',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.AUDIO_GEN,
      capabilities: JSON.stringify([CALL_TYPES.AUDIO_GEN]),
      input_price: '0',
      output_price: '0.5/sec',
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
      providers: {
        createOpenAI: () => ({ speech: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        experimental_generateSpeech: async () => ({
          audio: { uint8Array: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' },
          inputDurationSeconds: 1.5,
          durationSeconds: 999,
        }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_AUDIO,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-audio-1', input: 'hello', inputDuration: 1.5 },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.output_price, '0.5/sec');
    assert.strictEqual(latestLog.input_quantity, 0);
    assert.strictEqual(latestLog.output_quantity, 0);
    assert.strictEqual(latestLog.input_cost, 0);
    assert.strictEqual(latestLog.output_cost, 0);
    assert.strictEqual(latestLog.total_cost, 0);
  });

  it('video_gen 请求应按媒体二进制手动计算输出秒数并与输入秒数分离', async () => {
    mockEnv._addChannel({
      id: 'ch-video-cost',
      name: 'Video Cost Channel',
      key: 'video-cost-channel',
      provider: PROVIDERS.POLLINATIONS,
      api_key: 'sk-video-cost',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-video-cost',
      channel_id: 'ch-video-cost',
      code: 'gpt-video-1',
      name: 'gpt-video-1',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.VIDEO_GEN,
      capabilities: JSON.stringify([CALL_TYPES.VIDEO_GEN]),
      input_price: '0',
      output_price: '0.5/sec',
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
      providers: {
        createPollinations: () => ({ video: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        experimental_generateVideo: async () => ({
          videos: [{ base64: 'AAAA' }],
          inputDurationSeconds: 2,
          durationSeconds: 888,
        }),
      },
    });

    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_VIDEO,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-video-1', prompt: 'hello', inputDuration: 2 },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.output_price, '0.5/sec');
    assert.strictEqual(latestLog.input_quantity, 0);
    assert.strictEqual(latestLog.output_quantity, 0);
    assert.strictEqual(latestLog.total_cost, 0);
  });

  it('计费优先级: image_gen 在存在 /img 与 /sec 时应优先 /img（/sec 与 /img 同级时按场景选择）', async () => {
    mockEnv._addChannel({
      id: 'ch-img-priority',
      name: 'Image Priority Channel',
      key: 'image-priority-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-image-priority',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-img-priority',
      channel_id: 'ch-img-priority',
      code: 'gpt-image-priority',
      name: 'gpt-image-priority',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.IMAGE_GEN,
      capabilities: JSON.stringify([CALL_TYPES.IMAGE_GEN]),
      input_price: '0',
      output_price: '0.5/sec,0.02/img,1/M',
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
      providers: {
        createOpenAI: () => ({ image: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        generateImage: async () => ({ images: [{ base64: 'a' }, { base64: 'b' }, { base64: 'c' }] }),
      },
    });
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_IMAGES,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-image-priority', prompt: 'draw', n: 3, input_images_count: 1 },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.output_price, '0.02/img');
  });

  it('计费优先级: output 在存在 /img 与 /sec 时按统一优先级选择 /img', async () => {
    mockEnv._addChannel({
      id: 'ch-audio-priority',
      name: 'Audio Priority Channel',
      key: 'audio-priority-channel',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-audio-priority',
      base_url: '',
      weight: 1,
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
    });
    mockEnv._addModel({
      id: 'model-audio-priority',
      channel_id: 'ch-audio-priority',
      code: 'gpt-audio-priority',
      name: 'gpt-audio-priority',
      desc: '',
      aliases: '[]',
      call_type: CALL_TYPES.AUDIO_GEN,
      capabilities: JSON.stringify([CALL_TYPES.AUDIO_GEN]),
      input_price: '0',
      output_price: '0.02/img,0.5/sec,1/M',
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
      providers: {
        createOpenAI: () => ({ speech: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        experimental_generateSpeech: async () => ({
          audio: { uint8Array: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' },
          inputDurationSeconds: 2,
        }),
      },
    });
    const request = createMockRequest({
      method: 'POST',
      pathname: ROUTES.V1_AUDIO,
      headers: { authorization: 'Bearer test-admin-key' },
      body: { model: 'gpt-audio-priority', input: 'hello', inputDuration: 2 },
    });

    const response = await app.handleRequest(request, mockEnv);
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const latestLog = mockEnv._logs[mockEnv._logs.length - 1];
    assert.strictEqual(latestLog.output_price, '0.02/img');
  });
});

describe('请求链路: handleRequest', () => {
  it('请求处理阶段不应依赖 initializeDatabase 函数', async () => {
    const app = createApp({
      providers: {
        createOpenAI: () => ({ languageModel: (modelCode) => ({ modelCode }) }),
      },
      ai: {
        generateText: async () => ({
          text: 'ok',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      },
    });
    const request = createMockRequest({ method: 'GET', pathname: ROUTES.STATUS });
    const env = createMockEnv();

    const response = await app.handleRequest(request, env);

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(typeof app.initializeDatabase, 'undefined');
  });
});

describe('formatAIResponse(chat)', () => {
  it('应返回 chat 模型的 reasoning 与 tool_calls', async () => {
    const app = createApp({
      now: () => new Date('2026-04-23T00:00:00.000Z'),
      uuid: () => 'mock-uuid-1',
    });

    const response = await app.formatAIResponse(
      {
        text: 'final answer',
        reasoningText: 'internal reasoning summary',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      CALL_TYPES.CHAT,
      'gpt-4o',
    );

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const data = await response.json();
    assert.strictEqual(data.object, 'chat.completion');
    assert.strictEqual(data.choices[0].message.content, 'final answer');
    assert.strictEqual(data.choices[0].message.reasoning, 'internal reasoning summary');
    assert.deepStrictEqual(data.choices[0].message.tool_calls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      },
    ]);
  });

  it('应兼容 tool-call + input 参数并输出为 OpenAI function tool_calls', async () => {
    const app = createApp({
      now: () => new Date('2026-04-23T00:00:00.000Z'),
      uuid: () => 'mock-uuid-2',
    });

    const response = await app.formatAIResponse(
      {
        text: '',
        toolCalls: [
          {
            id: 'call_57d8f975d8354bd598c05a97cf4224ec',
            type: 'tool-call',
            toolName: 'name_of_color',
            input: { city: '大理', unit: 'celsius' },
          },
        ],
        usage: { inputTokens: 82, outputTokens: 77, totalTokens: 159 },
      },
      CALL_TYPES.CHAT,
      'gemini-flash-latest',
    );

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    const data = await response.json();
    assert.deepStrictEqual(data.choices[0].message.tool_calls, [
      {
        id: 'call_57d8f975d8354bd598c05a97cf4224ec',
        type: 'function',
        function: { name: 'name_of_color', arguments: '{"city":"大理","unit":"celsius"}' },
      },
    ]);
  });
});

describe('media-utils: getMp4Duration', () => {
  const TEST_MP4_FILE_PATH = '/Users/exc/Downloads/123.mp4';

  it('应可从真实 MP4 文件中解析出正数时长', async () => {
    const fileBuffer = await readFile(TEST_MP4_FILE_PATH);
    const duration = getMp4Duration(new Uint8Array(fileBuffer));
    assert.strictEqual(typeof duration, 'number');
    assert.ok(duration == 5.041666666666667);
  });
});

describe('media-utils: getMp3Duration', () => {
  const TEST_MP3_FILE_PATH = '/Users/exc/Downloads/tts.mp3';

  it('应可从真实 MP3 文件中解析出正数时长', async () => {
    const fileBuffer = await readFile(TEST_MP3_FILE_PATH);
    const duration = getMp3Duration(new Uint8Array(fileBuffer));
    console.log('mp3 duration:', duration)
    assert.strictEqual(typeof duration, 'number');
    assert.ok(duration > 0);
  });
});
