import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  buildSuccessLogEntry,
  getCooldownDuration,
  recordCallFailure,
  recordCallSuccess,
} from './call-result.js';
import { createGatewayRepository } from './db-repository.js';
import { calculateModelScore, selectChannelModels } from './model-selection.js';
import { buildExacgGenerateBody, extractExacgErrorMessage } from './v1/adapters/exacg.js';
import { createApp, CONSTANTS, SCHEMAS } from './worker.js';

const {
  CALL_TYPES,
  MODEL_STATUS,
  LOG_STATUS,
  HTTP_STATUS,
  ERROR_MESSAGES,
  PROVIDERS,
  ROUTES,
} = CONSTANTS;

const ADMIN_AUTH_HEADERS = { authorization: 'Bearer test-admin-key' };
const SUPPORTED_PROVIDER_IDS = ['openai', 'openai-compatible', 'exacg'];
const REMOVED_PROVIDER_IDS = ['google', 'gemini', 'anthropic', 'claude', 'openrouter', 'pollinations', 'microsoft-tts'];

function extractFrontendProviderIds(html) {
  const match = html.match(/PROVIDERS:\s*\[([^\]]*)\]/);
  assert.ok(match);
  return Array.from(match[1].matchAll(/'([^']+)'/g), (item) => item[1]);
}

describe('前端模型检测 UI', () => {
  it('public/index.html 应暴露模型检测 API 和两个检测入口', () => {
    const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

    assert.ok(html.includes("MODEL_CHECK: '/api/model/check'"));
    assert.ok(html.includes('checkChannelModel'));
    assert.ok(html.includes('checkModelForm'));
    assert.ok(html.includes('formatModelCheckMessage'));
  });

  it('public/index.html 不应再展示已移除的 provider', () => {
    const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

    assert.deepStrictEqual(extractFrontendProviderIds(html), SUPPORTED_PROVIDER_IDS);
    for (const provider of REMOVED_PROVIDER_IDS) {
      assert.ok(!html.includes(`'${provider}'`));
      assert.ok(!html.includes(`${provider}:`));
    }
  });
});

function normalizeSql(sql) {
  return sql.trim().toLowerCase().replaceAll('"', '').replace(/\s+/g, ' ');
}

function parseSqlList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseSetFields(normalizedSql, tableName) {
  const setClauseRaw = normalizedSql.split(' where ')[0].replace(`update ${tableName} set`, '').trim();
  return setClauseRaw.split(',').map((item) => item.trim().split('=')[0].trim());
}

function parseInsertFields(normalizedSql, tableName) {
  const insertStart = normalizedSql.indexOf(`insert into ${tableName}`);
  const openIndex = normalizedSql.indexOf('(', insertStart);
  const closeIndex = normalizedSql.indexOf(')', openIndex);
  return parseSqlList(normalizedSql.slice(openIndex + 1, closeIndex));
}

function parseSelectExpressions(normalizedSql) {
  const fromIndex = normalizedSql.indexOf(' from ');
  return parseSqlList(normalizedSql.slice('select '.length, fromIndex));
}

function getSqlExpressionValue(row, expression) {
  const expressionWithoutAlias = expression.replace(/\s+as\s+.+$/, '').trim();
  if (expressionWithoutAlias === 'count(*)') return row.total ?? 0;

  const match = expressionWithoutAlias.match(/^(?:(channels|channel_models|request_logs)\.)?([a-z_][a-z0-9_]*)$/);
  if (!match) return row[expressionWithoutAlias];

  const [, tableName, fieldName] = match;
  if (tableName === 'channels') {
    if (fieldName === 'id') return row.ch_id ?? row.id;
    if (fieldName === 'name') return row.channel_name ?? row.ch_name ?? row.name;
    if (fieldName === 'key') return row.ch_key ?? row.key;
    if (fieldName === 'weight') return row.ch_weight ?? row.weight;
  }
  return row[fieldName];
}

function toRawRows(normalizedSql, rows) {
  const expressions = parseSelectExpressions(normalizedSql);
  return rows.map((row) => expressions.map((expression) => getSqlExpressionValue(row, expression)));
}

function createMockEnv() {
  const channels = new Map();
  const models = new Map();
  const logs = [];

  const getChannelByKey = (key) => Array.from(channels.values()).find((channel) => channel.key === key);
  const getModelsByChannel = (channelId) => Array.from(models.values()).filter((model) => model.channel_id === channelId);
  const getModelsByCode = (code, channelId = '') =>
    Array.from(models.values()).filter((model) => model.code === code && (!channelId || model.channel_id === channelId));

  const applyModelUpdate = (normalizedSql, bindings) => {
    const fields = parseSetFields(normalizedSql, 'channel_models');
    const updates = Object.fromEntries(fields.map((field, index) => [field, bindings[index]]));
    const whereBindings = bindings.slice(fields.length);
    let changed = 0;

    for (const model of models.values()) {
      let matched = false;
      if (normalizedSql.includes('channel_models.id =') || normalizedSql.includes('where id')) {
        matched = model.id === whereBindings[0];
      } else if (normalizedSql.includes('channel_models.code =') || normalizedSql.includes('where code')) {
        const [code, channelId] = whereBindings;
        matched = model.code === code && (!channelId || model.channel_id === channelId);
      }
      if (!matched) continue;
      Object.assign(model, updates);
      changed += 1;
    }

    return { success: true, meta: { changes: changed } };
  };

  const filterLogs = (normalizedSql, bindings) => {
    const paginationBindingCount = normalizedSql.includes('offset') ? 2 : normalizedSql.includes('limit') ? 1 : 0;
    const filterValues = paginationBindingCount > 0 ? bindings.slice(0, -paginationBindingCount) : bindings;
    let valueIndex = 0;
    let filtered = [...logs];

    if (normalizedSql.includes('channel_id in')) {
      const channelKey = filterValues[valueIndex++];
      const channel = getChannelByKey(channelKey);
      filtered = filtered.filter((log) => log.channel_id === channel?.id);
    }
    if (normalizedSql.includes('request_logs.channel_id =') || normalizedSql.includes('channel_id =')) {
      const channelId = filterValues[valueIndex++];
      filtered = filtered.filter((log) => log.channel_id === channelId);
    }
    if (normalizedSql.includes('model_code =')) {
      const modelCode = filterValues[valueIndex++];
      filtered = filtered.filter((log) => log.model_code === modelCode);
    }
    if (normalizedSql.includes('status =')) {
      const status = filterValues[valueIndex++];
      filtered = filtered.filter((log) => log.status === status);
    }
    if (normalizedSql.includes('created_at >=')) {
      const startDate = filterValues[valueIndex++];
      filtered = filtered.filter((log) => log.created_at >= startDate);
    }
    if (normalizedSql.includes('created_at <=')) {
      const endDate = filterValues[valueIndex++];
      filtered = filtered.filter((log) => log.created_at <= endDate);
    }

    return filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  };

  const getJoinedModels = () =>
    Array.from(models.values()).map((model) => {
      const channel = channels.get(model.channel_id);
      return {
        ...model,
        channel_name: channel?.name || 'unknown',
        ch_id: channel?.id,
        ch_name: channel?.name,
        ch_key: channel?.key,
        provider: channel?.provider || '',
        api_key: channel?.api_key,
        base_url: channel?.base_url,
        ch_weight: channel?.weight ?? 1,
      };
    });

  const filterJoinedModels = (normalizedSql, bindings) => {
    let valueIndex = 0;
    let rows = getJoinedModels();

    if (normalizedSql.includes('channel_models.code =') || normalizedSql.includes('code =')) {
      const modelIdentifier = bindings[valueIndex++];
      const aliasLike = bindings[valueIndex++];
      const aliasIdentifier = String(aliasLike || '').replaceAll('%', '').replace(/^"+|"+$/g, '');
      rows = rows.filter((model) => {
        if (model.code === modelIdentifier) return true;
        try {
          const aliases = JSON.parse(model.aliases || '[]');
          return Array.isArray(aliases) && aliases.includes(aliasIdentifier);
        } catch {
          return false;
        }
      });
    }
    if (normalizedSql.includes('channel_models.status <>') || normalizedSql.includes('status <>')) {
      const disabledStatus = bindings[valueIndex++];
      rows = rows.filter((model) => model.status !== disabledStatus);
    }
    if (normalizedSql.includes('cooldown_until <')) {
      const nowValue = bindings[valueIndex++];
      rows = rows.filter((model) => !model.cooldown_until || model.cooldown_until < nowValue);
    }
    if (normalizedSql.includes('channel_models.channel_id = ?')) {
      const scopedChannelId = bindings[valueIndex++];
      rows = rows.filter((model) => model.channel_id === scopedChannelId);
    }

    return rows;
  };

  const queryRows = (normalizedSql, bindings) => {
    if (normalizedSql.includes('from channel_models inner join channels')) {
      return normalizedSql.includes(' where ') ? filterJoinedModels(normalizedSql, bindings) : getJoinedModels();
    }

    if (normalizedSql.includes('from channels')) {
      if (normalizedSql.includes('select count(*)')) return [{ total: channels.size }];
      if (normalizedSql.includes('where channels.id =') || normalizedSql.includes('where id =')) {
        const channel = channels.get(bindings[0]);
        return channel ? [channel] : [];
      }
      if (normalizedSql.includes('where channels.key =') || normalizedSql.includes('where key =')) {
        const channel = getChannelByKey(bindings[0]);
        return channel ? [channel] : [];
      }
      if (normalizedSql.includes('order by')) {
        const limit = normalizedSql.includes('limit') ? bindings[0] : channels.size;
        const offset = normalizedSql.includes('offset') ? bindings[bindings.length - 1] : 0;
        return Array.from(channels.values()).slice(offset, offset + limit);
      }
      return Array.from(channels.values());
    }

    if (normalizedSql.includes('from channel_models')) {
      if (normalizedSql.includes('channel_models.code =') || normalizedSql.includes('where code =')) {
        const channelId = normalizedSql.includes('channel_models.channel_id = ?') ? bindings[1] || '' : '';
        return getModelsByCode(bindings[0], channelId);
      }
      if (normalizedSql.includes('channel_models.channel_id = ?') || normalizedSql.includes('where channel_id =')) {
        return getModelsByChannel(bindings[0]);
      }
      if (normalizedSql.includes('channel_models.id =') || normalizedSql.includes('where id =')) {
        const model = models.get(bindings[0]);
        return model ? [model] : [];
      }
      return Array.from(models.values());
    }

    if (normalizedSql.includes('from request_logs')) {
      if (normalizedSql.includes('select count(*)')) return [{ total: filterLogs(normalizedSql, bindings).length }];
      const filtered = filterLogs(normalizedSql, bindings);
      const limit = normalizedSql.includes('limit')
        ? bindings[bindings.length - (normalizedSql.includes('offset') ? 2 : 1)]
        : filtered.length;
      const offset = normalizedSql.includes('offset') ? bindings[bindings.length - 1] : 0;
      return filtered.slice(offset, offset + limit);
    }

    return [];
  };

  return {
    ADMIN_KEY: 'test-admin-key',
    ENV: 'dev',
    DB: {
      prepare: (sql) => {
        const normalizedSql = normalizeSql(sql);
        return {
          bind(...args) {
            this._bindings = args;
            return this;
          },
          async run() {
            const bindings = this._bindings || [];

            if (normalizedSql.includes('insert into channels')) {
              const fields = parseInsertFields(normalizedSql, 'channels');
              for (let index = 0; index < bindings.length; index += fields.length) {
                const row = Object.fromEntries(fields.map((field, offset) => [field, bindings[index + offset]]));
                channels.set(row.id, row);
              }
              return { success: true };
            }

            if (normalizedSql.includes('insert into channel_models')) {
              const fields = parseInsertFields(normalizedSql, 'channel_models');
              for (let index = 0; index < bindings.length; index += fields.length) {
                const row = Object.fromEntries(fields.map((field, offset) => [field, bindings[index + offset]]));
                models.set(row.id, row);
              }
              return { success: true };
            }

            if (
              normalizedSql.includes('delete from channel_models where channel_models.channel_id') ||
              normalizedSql.includes('delete from channel_models where channel_id')
            ) {
              for (const [id, model] of models.entries()) {
                if (model.channel_id === bindings[0]) models.delete(id);
              }
              return { success: true };
            }

            if (
              normalizedSql.includes('delete from channels where channels.id') ||
              normalizedSql.includes('delete from channels where id')
            ) {
              channels.delete(bindings[0]);
              return { success: true };
            }

            if (
              normalizedSql.includes('delete from channel_models where channel_models.id') ||
              normalizedSql.includes('delete from channel_models where id')
            ) {
              models.delete(bindings[0]);
              return { success: true };
            }

            if (
              normalizedSql.includes('delete from channel_models') &&
              (normalizedSql.includes('channel_models.code =') || normalizedSql.includes('where code'))
            ) {
              const [code, channelId] = bindings;
              let changed = 0;
              for (const [id, model] of models.entries()) {
                if (model.code === code && (!channelId || model.channel_id === channelId)) {
                  models.delete(id);
                  changed += 1;
                }
              }
              return { success: true, meta: { changes: changed } };
            }

            if (normalizedSql.includes('update channels set')) {
              const fields = parseSetFields(normalizedSql, 'channels');
              const channelId = bindings[fields.length];
              const channel = channels.get(channelId);
              if (!channel) return { success: false };
              fields.forEach((field, index) => {
                channel[field] = bindings[index];
              });
              return { success: true };
            }

            if (normalizedSql.includes('update channel_models set')) {
              return applyModelUpdate(normalizedSql, bindings);
            }

            if (normalizedSql.includes('insert into request_logs')) {
              const fields = parseInsertFields(normalizedSql, 'request_logs');
              for (let index = 0; index < bindings.length; index += fields.length) {
                logs.push(Object.fromEntries(fields.map((field, offset) => [field, bindings[index + offset]])));
              }
              return { success: true };
            }

            return { success: true };
          },
          async raw() {
            const bindings = this._bindings || [];
            return toRawRows(normalizedSql, queryRows(normalizedSql, bindings));
          },
          async all() {
            const bindings = this._bindings || [];

            if (normalizedSql.includes('select * from channel_models where channel_id')) {
              return { results: getModelsByChannel(bindings[0]) };
            }

            if (normalizedSql.includes('select * from channels where id')) {
              const channel = channels.get(bindings[0]);
              return { results: channel ? [channel] : [] };
            }

            if (normalizedSql.includes('select * from channels where key')) {
              const channel = getChannelByKey(bindings[0]);
              return { results: channel ? [channel] : [] };
            }

            if (normalizedSql.includes('select * from channel_models where id')) {
              const model = models.get(bindings[0]);
              return { results: model ? [model] : [] };
            }

            if (normalizedSql.includes('select * from channel_models where code')) {
              return { results: getModelsByCode(bindings[0], bindings[1] || '') };
            }

            if (normalizedSql.includes('select count(*)') && normalizedSql.includes('from channels')) {
              return { results: [{ total: channels.size }] };
            }

            if (normalizedSql.includes('select count(*)') && normalizedSql.includes('from request_logs')) {
              return { results: [{ total: filterLogs(normalizedSql, bindings).length }] };
            }

            if (normalizedSql.includes('select * from channels order by')) {
              const [limit, offset] = bindings;
              return { results: Array.from(channels.values()).slice(offset, offset + limit) };
            }

            if (normalizedSql.includes('where (cm.code =') || normalizedSql.includes('cm.aliases like')) {
              const [modelIdentifier, aliasLike, disabledStatus, nowValue, scopedChannelId] = bindings;
              const aliasIdentifier = String(aliasLike || '').replaceAll('%', '').replace(/^"+|"+$/g, '');
              const results = Array.from(models.values())
                .filter((model) => {
                  const channelMatched = scopedChannelId ? model.channel_id === scopedChannelId : true;
                  const statusMatched = model.status !== disabledStatus;
                  const cooldownMatched = !model.cooldown_until || model.cooldown_until < nowValue;
                  let identifierMatched = model.code === modelIdentifier;
                  if (!identifierMatched) {
                    try {
                      const aliases = JSON.parse(model.aliases || '[]');
                      identifierMatched = Array.isArray(aliases) && aliases.includes(aliasIdentifier);
                    } catch {
                      identifierMatched = false;
                    }
                  }
                  return channelMatched && statusMatched && cooldownMatched && identifierMatched;
                })
                .map((model) => {
                  const channel = channels.get(model.channel_id);
                  return {
                    ...model,
                    ch_id: channel?.id,
                    ch_name: channel?.name,
                    ch_key: channel?.key,
                    provider: channel?.provider,
                    api_key: channel?.api_key,
                    base_url: channel?.base_url,
                    ch_weight: channel?.weight ?? 1,
                  };
                });
              return { results };
            }

            if (normalizedSql.includes('from channel_models cm join channels c on cm.channel_id = c.id')) {
              return {
                results: Array.from(models.values()).map((model) => {
                  const channel = channels.get(model.channel_id);
                  return {
                    ...model,
                    channel_name: channel?.name || 'unknown',
                    provider: channel?.provider || '',
                  };
                }),
              };
            }

            if (normalizedSql.includes('from request_logs')) {
              const filtered = filterLogs(normalizedSql, bindings);
              const limit = bindings[bindings.length - 2] || filtered.length;
              const offset = bindings[bindings.length - 1] || 0;
              return { results: filtered.slice(offset, offset + limit) };
            }

            return { results: [] };
          },
          async first() {
            const bindings = this._bindings || [];

            if (normalizedSql.includes('select * from channels where id')) {
              return channels.get(bindings[0]) || null;
            }

            if (normalizedSql.includes('select * from channels where key')) {
              return getChannelByKey(bindings[0]) || null;
            }

            if (normalizedSql.includes('select * from channel_models where id')) {
              return models.get(bindings[0]) || null;
            }

            if (normalizedSql.includes('select * from channel_models where code')) {
              return getModelsByCode(bindings[0], bindings[1] || '')[0] || null;
            }

            if (normalizedSql.includes('select count(*)') && normalizedSql.includes('from channels')) {
              return { total: channels.size };
            }

            if (normalizedSql.includes('select count(*)') && normalizedSql.includes('from request_logs')) {
              return { total: filterLogs(normalizedSql, bindings).length };
            }

            return null;
          },
        };
      },
    },
    _channels: channels,
    _models: models,
    _logs: logs,
    _addChannel: (channel) => channels.set(channel.id, channel),
    _addModel: (model) => models.set(model.id, model),
    _addLog: (log) => logs.push(log),
    _clear: () => {
      channels.clear();
      models.clear();
      logs.length = 0;
    },
  };
}

function createMockRequest(options = {}) {
  const { method = 'GET', pathname = '/', headers = {}, body = null } = options;
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const url = `https://example.com${pathname}`;

  return {
    method,
    url,
    headers: {
      get: (key) => normalizedHeaders[String(key).toLowerCase()],
    },
    json: async () => body,
    formData: async () => new Map(Object.entries(body || {})),
  };
}

function createMockFetch(mockResponses = {}, onCall = () => {}) {
  return async (url, options) => {
    const urlString = typeof url === 'string' ? url : url.toString();
    onCall(urlString, options);

    for (const [pattern, response] of Object.entries(mockResponses)) {
      if (urlString.includes(pattern)) {
        const status = response.status || (response.ok === false ? 500 : 200);
        const body = response.body ?? response.data ?? response;
        const headers = new Headers(response.headers || { 'content-type': 'application/json' });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
      }
    }

    return new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function addChannelWithModel(mockEnv, overrides = {}) {
  const channelId = overrides.channelId || 'channel-1';
  const modelId = overrides.modelId || 'model-1';
  mockEnv._addChannel({
    id: channelId,
    name: overrides.channelName || 'Main Channel',
    key: overrides.channelKey || 'main-channel',
    provider: overrides.provider || PROVIDERS.OPENAI,
    api_key: overrides.apiKey || 'sk-test',
    base_url: overrides.baseURL || '',
    weight: overrides.channelWeight ?? 1,
    created_at: '2026-04-12T00:00:00Z',
    updated_at: '2026-04-12T00:00:00Z',
  });
  mockEnv._addModel({
    id: modelId,
    channel_id: channelId,
    code: overrides.modelCode || 'gpt-4o',
    name: overrides.modelName || 'GPT-4o',
    desc: '',
    aliases: '[]',
    call_type: overrides.callType || CALL_TYPES.CHAT,
    capabilities: JSON.stringify([overrides.callType || CALL_TYPES.CHAT]),
    input_price: '0',
    output_price: '0',
    status: overrides.status || MODEL_STATUS.ACTIVE,
    weight: overrides.modelWeight ?? 1,
    avg_latency_ms: 0,
    success_rate: 1,
    error_rate: 0,
    consecutive_failures: 0,
    cooldown_until: null,
    request_count: 0,
    input_usage: 0,
    outpu_usage: 0,
    total_cost: 0,
    last_updated: '2026-04-12T00:00:00Z',
    headers: '{}',
  });
  return { channelId, modelId };
}

describe('V1 OpenAI-compatible 网关', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00.000Z'),
      uuid: (() => {
        let index = 0;
        return () => `v1-log-${++index}`;
      })(),
    });
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('GET /v1/models 应返回未禁用模型的 code 与 aliases 并去重', async () => {
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-list-a',
      channelName: 'OpenAI A',
      channelKey: 'openai-a',
      modelId: 'm-v1-list-a',
      modelCode: 'gpt-4o',
    });
    Object.assign(mockEnv._models.get('m-v1-list-a'), {
      aliases: JSON.stringify(['my-gpt', 'gpt-4o', '', '  ']),
    });
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-list-b',
      channelName: 'OpenAI B',
      channelKey: 'openai-b',
      modelId: 'm-v1-list-b',
      modelCode: 'gpt-4o',
    });
    Object.assign(mockEnv._models.get('m-v1-list-b'), {
      aliases: JSON.stringify(['my-gpt', 'mirror']),
    });
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-list-disabled',
      channelKey: 'openai-disabled',
      modelId: 'm-v1-list-disabled',
      modelCode: 'disabled-model',
      status: MODEL_STATUS.DISABLE,
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'GET',
        pathname: '/v1/models',
        headers: ADMIN_AUTH_HEADERS,
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.object, 'list');
    assert.deepStrictEqual(data.data.map((item) => item.id).sort(), ['gpt-4o', 'mirror', 'my-gpt']);
  });

  it('POST /v1/chat/completions 应选择别名模型、重写上游 model 并记录成功', async () => {
    const calls = [];
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-chat',
      channelName: 'Compatible',
      provider: PROVIDERS.OPENAI_COMPATIBLE,
      baseURL: 'https://compatible.example.com/v1',
      modelId: 'm-v1-chat',
      modelCode: 'real-chat-model',
    });
    Object.assign(mockEnv._models.get('m-v1-chat'), {
      aliases: JSON.stringify(['public-chat-model']),
      input_price: '2/M',
      output_price: '3/M',
      headers: JSON.stringify({ 'x-upstream-model': 'yes' }),
    });
    app = createApp({
      fetch: createMockFetch(
        {
          'compatible.example.com/v1/chat/completions': {
            data: {
              id: 'chatcmpl-test',
              object: 'chat.completion',
              model: 'real-chat-model',
              choices: [{ message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
            },
          },
        },
        (url, options) => calls.push({ url, options }),
      ),
      now: () => new Date('2026-04-12T00:00:00.000Z'),
      uuid: () => 'v1-success-log',
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/v1/chat/completions',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          model: 'public-chat-model',
          messages: [{ role: 'user', content: 'hello' }],
          temperature: 0.2,
        },
      }),
      mockEnv,
    );
    const data = await response.json();

    const upstreamBody = JSON.parse(calls[0].options.body);
    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.id, 'chatcmpl-test');
    assert.strictEqual(calls[0].url, 'https://compatible.example.com/v1/chat/completions');
    assert.strictEqual(calls[0].options.headers.get('authorization'), 'Bearer sk-test');
    assert.strictEqual(calls[0].options.headers.get('x-upstream-model'), 'yes');
    assert.strictEqual(upstreamBody.model, 'real-chat-model');
    assert.strictEqual(upstreamBody.temperature, 0.2);
    assert.strictEqual(mockEnv._logs.length, 1);
    assert.strictEqual(mockEnv._logs[0].status, LOG_STATUS.SUCCESS);
    assert.strictEqual(mockEnv._logs[0].request_model, 'public-chat-model');
    assert.strictEqual(mockEnv._logs[0].input_quantity, 1000);
    assert.strictEqual(mockEnv._logs[0].output_quantity, 200);
    assert.strictEqual(mockEnv._models.get('m-v1-chat').request_count, 1);
  });

  it('POST /v1/chat/completions 上游失败时应记录失败并 fallback 到下一个候选', async () => {
    const calls = [];
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-fallback-a',
      channelKey: 'fallback-a',
      channelName: 'Fallback A',
      provider: PROVIDERS.OPENAI_COMPATIBLE,
      baseURL: 'https://first.example.com/v1',
      modelId: 'm-v1-fallback-a',
      modelCode: 'shared-model',
      modelWeight: 10,
    });
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-fallback-b',
      channelKey: 'fallback-b',
      channelName: 'Fallback B',
      provider: PROVIDERS.OPENAI_COMPATIBLE,
      baseURL: 'https://second.example.com/v1',
      modelId: 'm-v1-fallback-b',
      modelCode: 'shared-model',
      modelWeight: 1,
    });
    app = createApp({
      fetch: createMockFetch(
        {
          'first.example.com/v1/chat/completions': {
            ok: false,
            status: 500,
            data: { error: { message: 'first failed' } },
          },
          'second.example.com/v1/chat/completions': {
            data: {
              id: 'chatcmpl-fallback',
              object: 'chat.completion',
              choices: [{ message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          },
        },
        (url) => calls.push(url),
      ),
      now: () => new Date('2026-04-12T00:00:00.000Z'),
      uuid: (() => {
        let index = 0;
        return () => `v1-fallback-log-${++index}`;
      })(),
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/v1/chat/completions',
        headers: ADMIN_AUTH_HEADERS,
        body: { model: 'shared-model', messages: [{ role: 'user', content: 'hello' }] },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.id, 'chatcmpl-fallback');
    assert.deepStrictEqual(calls, [
      'https://first.example.com/v1/chat/completions',
      'https://second.example.com/v1/chat/completions',
    ]);
    assert.deepStrictEqual(mockEnv._logs.map((log) => log.status), [LOG_STATUS.ERROR, LOG_STATUS.SUCCESS]);
    assert.strictEqual(mockEnv._models.get('m-v1-fallback-a').consecutive_failures, 1);
    assert.strictEqual(mockEnv._models.get('m-v1-fallback-b').request_count, 1);
  });

  it('POST /v1/images/generations 应通过 Exacg 适配器生成图片并记录图片用量', async () => {
    const calls = [];
    addChannelWithModel(mockEnv, {
      channelId: 'ch-v1-exacg',
      channelName: 'Exacg',
      provider: PROVIDERS.EXACG,
      baseURL: 'https://exacg.example.com/api/v1/',
      modelId: 'm-v1-exacg',
      modelCode: '7',
      callType: CALL_TYPES.IMAGE_GEN,
    });
    Object.assign(mockEnv._models.get('m-v1-exacg'), {
      aliases: JSON.stringify(['public-image-model']),
      output_price: '0.02/img',
      headers: JSON.stringify({ 'x-exacg-channel': 'yes' }),
    });
    app = createApp({
      fetch: createMockFetch(
        {
          'exacg.example.com/api/v1/generate_image': {
            body: JSON.stringify({
              data: {
                image_id: 0,
                image_url: 'https://cdn.example.com/generated.png',
                model_name: 'Miaomiao Harem vPred Dogma 1.1',
                points_used: 1,
                remaining_points: 5068,
              },
              message: '图像生成成功',
              success: true,
            }),
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          },
        },
        (url, options) => calls.push({ url, options }),
      ),
      now: () => new Date('2026-04-12T00:00:00.000Z'),
      uuid: () => 'v1-exacg-log',
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/v1/images/generations',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          model: 'public-image-model',
          prompt: 'a clean anime portrait',
          size: '768x512',
          seed: 42,
          providerOptions: {
            exacg: {
              negative_prompt: 'low quality',
              steps: 24,
              cfg: 7,
              image_source: 'https://cdn.example.com/source.png',
            },
          },
        },
      }),
      mockEnv,
    );
    const data = await response.json();
    const upstreamBody = JSON.parse(calls[0].options.body);

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(calls[0].url, 'https://exacg.example.com/api/v1/generate_image');
    assert.strictEqual(calls[0].options.headers.get('authorization'), 'Bearer sk-test');
    assert.strictEqual(calls[0].options.headers.get('x-exacg-channel'), 'yes');
    assert.deepStrictEqual(upstreamBody, {
      prompt: 'a clean anime portrait',
      seed: 42,
      model_index: 7,
      width: 768,
      height: 512,
      negative_prompt: 'low quality',
      steps: 24,
      cfg: 7,
      image_source: 'https://cdn.example.com/source.png',
    });
    assert.strictEqual(data.created, Math.floor(new Date('2026-04-12T00:00:00.000Z').getTime() / 1000));
    assert.deepStrictEqual(data.data, [{ url: 'https://cdn.example.com/generated.png' }]);
    assert.strictEqual(mockEnv._logs.length, 1);
    assert.strictEqual(mockEnv._logs[0].status, LOG_STATUS.SUCCESS);
    assert.strictEqual(mockEnv._logs[0].request_model, 'public-image-model');
    assert.strictEqual(mockEnv._logs[0].output_quantity, 1);
    assert.strictEqual(mockEnv._models.get('m-v1-exacg').request_count, 1);
  });

  it('/v1 未知 endpoint 应返回 404', async () => {
    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/v1/files',
        headers: ADMIN_AUTH_HEADERS,
        body: { model: 'gpt-4o' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.NOT_FOUND);
    assert.strictEqual(data.error, ERROR_MESSAGES.NOT_FOUND);
  });
});

describe('模型可用性检测 API', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('POST /api/model/check 应通过 OpenAI-compatible 适配器发起最小探活请求', async () => {
    const calls = [];
    const app = createApp({
      fetch: createMockFetch(
        {
          'compatible.example.com/v1/chat/completions': {
            data: {
              id: 'chatcmpl-check',
              choices: [{ message: { role: 'assistant', content: 'OK' } }],
            },
          },
        },
        (url, options) => calls.push({ url, options }),
      ),
      now: (() => {
        const values = [
          new Date('2026-04-12T00:00:00.000Z'),
          new Date('2026-04-12T00:00:00.123Z'),
        ];
        return () => values.shift() || new Date('2026-04-12T00:00:00.123Z');
      })(),
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/model/check',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          provider: PROVIDERS.OPENAI_COMPATIBLE,
          apiKey: 'sk-check',
          baseURL: 'https://compatible.example.com/v1',
          model: 'check-model',
          callType: CALL_TYPES.CHAT,
          headers: { 'x-check': 'yes' },
          timeoutMs: 1000,
        },
      }),
      mockEnv,
    );
    const data = await response.json();
    const upstreamBody = JSON.parse(calls[0].options.body);

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.model_code, 'check-model');
    assert.strictEqual(data.data.call_type, CALL_TYPES.CHAT);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
    assert.strictEqual(data.data.latency_ms, 123);
    assert.strictEqual(data.data.error_message, '');
    assert.strictEqual(calls[0].url, 'https://compatible.example.com/v1/chat/completions');
    assert.strictEqual(calls[0].options.headers.get('authorization'), 'Bearer sk-check');
    assert.strictEqual(calls[0].options.headers.get('x-check'), 'yes');
    assert.strictEqual(upstreamBody.model, 'check-model');
  });

  it('POST /api/model/check 应通过 Exacg 适配器发起图片生成探活请求', async () => {
    const calls = [];
    const app = createApp({
      fetch: createMockFetch(
        {
          'exacg.example.com/api/v1/generate_image': {
            body: JSON.stringify({
              data: { image_url: 'https://cdn.example.com/check.png' },
              message: '图像生成成功',
              success: true,
            }),
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          },
        },
        (url, options) => calls.push({ url, options }),
      ),
      now: (() => {
        const values = [
          new Date('2026-04-12T00:00:00.000Z'),
          new Date('2026-04-12T00:00:00.075Z'),
        ];
        return () => values.shift() || new Date('2026-04-12T00:00:00.075Z');
      })(),
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/model/check',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          provider: PROVIDERS.EXACG,
          apiKey: 'exacg-key',
          baseURL: 'https://exacg.example.com/api/v1/',
          model: '8',
          callType: CALL_TYPES.IMAGE_GEN,
          headers: { 'x-check': 'yes' },
          timeoutMs: 1000,
        },
      }),
      mockEnv,
    );
    const data = await response.json();
    const upstreamBody = JSON.parse(calls[0].options.body);

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.model_code, '8');
    assert.strictEqual(data.data.call_type, CALL_TYPES.IMAGE_GEN);
    assert.strictEqual(data.data.api_accessible, true);
    assert.strictEqual(data.data.data_available, true);
    assert.strictEqual(data.data.latency_ms, 75);
    assert.strictEqual(data.data.error_message, '');
    assert.strictEqual(calls[0].url, 'https://exacg.example.com/api/v1/generate_image');
    assert.strictEqual(calls[0].options.headers.get('authorization'), 'Bearer exacg-key');
    assert.strictEqual(calls[0].options.headers.get('x-check'), 'yes');
    assert.strictEqual(upstreamBody.model_index, 8);
    assert.strictEqual(upstreamBody.seed, 0);
    assert.strictEqual(upstreamBody.steps, 30);
    assert.ok(String(upstreamBody.prompt).length > 0);
  });

  it('POST /api/model/check 对 Exacg 非图片调用类型应返回不可用结果且不请求上游', async () => {
    const calls = [];
    const app = createApp({
      fetch: createMockFetch({}, (url) => calls.push(url)),
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/model/check',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          provider: PROVIDERS.EXACG,
          apiKey: 'exacg-key',
          baseURL: 'https://exacg.example.com/api/v1',
          model: '8',
          callType: CALL_TYPES.CHAT,
        },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
    assert.ok(data.data.error_message.includes('Unsupported Exacg call type'));
    assert.strictEqual(calls.length, 0);
  });

  it('POST /api/model/check 对未知 provider 应返回不可用结果', async () => {
    const app = createApp();
    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/model/check',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          provider: 'unknown-provider',
          apiKey: 'unknown-key',
          baseURL: '',
          model: 'unknown-model',
          callType: CALL_TYPES.CHAT,
        },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.api_accessible, false);
    assert.strictEqual(data.data.data_available, false);
    assert.ok(data.data.error_message.includes('Unsupported provider'));
  });
});

describe('exacg adapter: 请求体转换', () => {
  it('buildExacgGenerateBody 未传 steps 时应使用默认值 30', () => {
    const body = buildExacgGenerateBody('9', { prompt: 'portrait' });

    assert.strictEqual(body.prompt, 'portrait');
    assert.strictEqual(body.seed, 0);
    assert.strictEqual(body.model_index, 9);
    assert.strictEqual(body.steps, 30);
  });

  it('buildExacgGenerateBody 应支持 provider_options.exacg 并忽略非法 size', () => {
    assert.deepStrictEqual(
      buildExacgGenerateBody('9', {
        prompt: 'portrait',
        size: 'bad-size',
        provider_options: {
          exacg: {
            negative_prompt: 'blur',
            steps: 20,
          },
        },
      }),
      {
        prompt: 'portrait',
        seed: 0,
        model_index: 9,
        negative_prompt: 'blur',
        steps: 20,
      },
    );
  });

  it('buildExacgGenerateBody 应拒绝空值和非数字 model_index', () => {
    assert.throws(() => buildExacgGenerateBody('', { prompt: 'test' }), /model_index must be numeric/);
    assert.throws(() => buildExacgGenerateBody('not-number', { prompt: 'test' }), /model_index must be numeric/);
  });

  it('extractExacgErrorMessage 不应把 success=true 的 message 当成错误', () => {
    assert.strictEqual(extractExacgErrorMessage({ success: true, message: '图像生成成功' }), '');
    assert.strictEqual(extractExacgErrorMessage({ success: false, message: '余额不足' }), '余额不足');
    assert.strictEqual(extractExacgErrorMessage({ error: { message: 'invalid key' } }), 'invalid key');
  });
});

describe('认证、CORS 与基础路由', () => {
  it('OPTIONS 应返回 CORS 预检响应', async () => {
    const app = createApp();
    const response = await app.handleRequest(createMockRequest({ method: 'OPTIONS' }), createMockEnv());

    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('/api/* 未鉴权应返回 401', async () => {
    const app = createApp();
    const response = await app.handleRequest(createMockRequest({ pathname: '/api/channels' }), createMockEnv());
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.UNAUTHORIZED);
    assert.strictEqual(data.error, ERROR_MESSAGES.UNAUTHORIZED);
  });

  it('未知路径应返回 404', async () => {
    const app = createApp();
    const response = await app.handleRequest(createMockRequest({ pathname: '/unknown' }), createMockEnv());
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.NOT_FOUND);
    assert.strictEqual(data.error, ERROR_MESSAGES.NOT_FOUND);
  });
});

describe('Schema: provider 与 call_type', () => {
  it('ProviderEnum 应拒绝已移除的 openai-stream', () => {
    assert.throws(() => SCHEMAS.ProviderEnum.parse('openai-stream'));
  });

  it('ProviderEnum 和常量不应再接受已移除的 provider', () => {
    const providerValues = Object.values(PROVIDERS);

    assert.deepStrictEqual(providerValues, SUPPORTED_PROVIDER_IDS);
    for (const provider of REMOVED_PROVIDER_IDS) {
      assert.ok(!providerValues.includes(provider));
      assert.throws(() => SCHEMAS.ProviderEnum.parse(provider));
    }
  });

  it('CallTypeEnum 应保留模型元数据类型', () => {
    assert.strictEqual(SCHEMAS.CallTypeEnum.parse(CALL_TYPES.IMAGE_GEN), CALL_TYPES.IMAGE_GEN);
    assert.strictEqual(SCHEMAS.CallTypeEnum.parse(CALL_TYPES.MIX), CALL_TYPES.MIX);
  });
});

describe('model-selection: 选择渠道和模型', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('calculateModelScore 应按权重、成功率、延迟和失败次数计算分数', () => {
    const score = calculateModelScore({
      weight: 3,
      ch_weight: 2,
      success_rate: 0.8,
      avg_latency_ms: 100,
      consecutive_failures: 1,
    });

    assert.strictEqual(score, 69);
  });

  it('selectChannelModels 应匹配 alias/code，过滤禁用和冷却模型，并按分数排序', async () => {
    addChannelWithModel(mockEnv, {
      channelId: 'ch-a',
      channelKey: 'channel-a',
      channelName: 'Channel A',
      modelId: 'm-chat',
      modelCode: 'chat-code',
      channelWeight: 1,
      modelWeight: 1,
      callType: CALL_TYPES.CHAT,
    });
    Object.assign(mockEnv._models.get('m-chat'), {
      aliases: JSON.stringify(['shared-alias']),
      avg_latency_ms: 20,
      success_rate: 1,
      consecutive_failures: 0,
    });

    addChannelWithModel(mockEnv, {
      channelId: 'ch-b',
      channelKey: 'channel-b',
      channelName: 'Channel B',
      modelId: 'm-mix',
      modelCode: 'mix-code',
      channelWeight: 5,
      modelWeight: 2,
      callType: CALL_TYPES.MIX,
    });
    Object.assign(mockEnv._models.get('m-mix'), {
      aliases: JSON.stringify(['shared-alias']),
      avg_latency_ms: 0,
      success_rate: 0.8,
      consecutive_failures: 0,
    });

    addChannelWithModel(mockEnv, {
      channelId: 'ch-disabled',
      channelKey: 'channel-disabled',
      modelId: 'm-disabled',
      modelCode: 'disabled-code',
      status: MODEL_STATUS.DISABLE,
      callType: CALL_TYPES.CHAT,
    });
    mockEnv._models.get('m-disabled').aliases = JSON.stringify(['shared-alias']);

    addChannelWithModel(mockEnv, {
      channelId: 'ch-cooldown',
      channelKey: 'channel-cooldown',
      modelId: 'm-cooldown',
      modelCode: 'cooldown-code',
      callType: CALL_TYPES.CHAT,
    });
    Object.assign(mockEnv._models.get('m-cooldown'), {
      aliases: JSON.stringify(['shared-alias']),
      cooldown_until: '2026-04-12T00:30:00.000Z',
    });

    addChannelWithModel(mockEnv, {
      channelId: 'ch-image',
      channelKey: 'channel-image',
      modelId: 'm-image',
      modelCode: 'image-code',
      callType: CALL_TYPES.IMAGE_GEN,
    });
    mockEnv._models.get('m-image').aliases = JSON.stringify(['shared-alias']);

    const selections = await selectChannelModels(mockEnv.DB, {
      model: 'shared-alias',
      callType: CALL_TYPES.CHAT,
      now: new Date('2026-04-12T00:00:00.000Z'),
    });

    assert.deepStrictEqual(selections.map((item) => item.model.id), ['m-mix', 'm-chat']);
    assert.deepStrictEqual(selections.map((item) => item.channel.id), ['ch-b', 'ch-a']);
    assert.strictEqual(selections[0].score, 110);
    assert.strictEqual(selections[1].score, 69.8);
  });

  it('selectChannelModels 应支持按指定渠道过滤', async () => {
    addChannelWithModel(mockEnv, {
      channelId: 'ch-a',
      channelKey: 'channel-a',
      modelId: 'm-a',
      modelCode: 'same-code',
      callType: CALL_TYPES.CHAT,
    });
    addChannelWithModel(mockEnv, {
      channelId: 'ch-b',
      channelKey: 'channel-b',
      modelId: 'm-b',
      modelCode: 'same-code',
      callType: CALL_TYPES.CHAT,
    });

    const selections = await selectChannelModels(mockEnv.DB, {
      model: 'same-code',
      callType: CALL_TYPES.CHAT,
      channelId: 'ch-b',
      now: new Date('2026-04-12T00:00:00.000Z'),
    });

    assert.deepStrictEqual(selections.map((item) => item.model.id), ['m-b']);
    assert.strictEqual(selections[0].channel.key, 'channel-b');
  });

  it('selectChannelModels 无匹配模型时应返回空数组', async () => {
    addChannelWithModel(mockEnv, {
      channelId: 'ch-a',
      modelId: 'm-a',
      modelCode: 'image-only',
      callType: CALL_TYPES.IMAGE_GEN,
    });

    const selections = await selectChannelModels(mockEnv.DB, {
      model: 'image-only',
      callType: CALL_TYPES.CHAT,
      now: new Date('2026-04-12T00:00:00.000Z'),
    });

    assert.deepStrictEqual(selections, []);
  });
});

describe('call-result: 调用成功和失败后的处理', () => {
  let mockEnv;

  const createSelection = (modelOverrides = {}) => {
    addChannelWithModel(mockEnv, {
      channelId: 'ch-result',
      channelKey: 'result-channel',
      channelName: 'Result Channel',
      modelId: 'm-result',
      modelCode: 'result-model',
      callType: CALL_TYPES.IMAGE_GEN,
    });
    Object.assign(mockEnv._models.get('m-result'), modelOverrides);
    return {
      channel: {
        id: 'ch-result',
        name: 'Result Channel',
        key: 'result-channel',
        provider: PROVIDERS.OPENAI,
        api_key: 'sk-test',
        base_url: '',
      },
      model: mockEnv._models.get('m-result'),
    };
  };

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('buildSuccessLogEntry 应按 usage 和图片数量计算成功日志成本', () => {
    const selection = createSelection({
      input_price: '2/M',
      output_price: '0.02/img,10/M',
    });

    const entry = buildSuccessLogEntry({
      requestBody: { model: 'alias-model' },
      responseBody: {
        usage: { inputTokens: 1000, outputTokens: 20 },
        images: [{ base64: 'a' }, { base64: 'b' }],
      },
      selection,
      callType: CALL_TYPES.IMAGE_GEN,
      latencyMs: 123,
    });

    assert.strictEqual(entry.status, LOG_STATUS.SUCCESS);
    assert.strictEqual(entry.request_model, 'alias-model');
    assert.strictEqual(entry.input_quantity, 1000);
    assert.strictEqual(entry.output_quantity, 2);
    assert.strictEqual(entry.input_price, '2/M');
    assert.strictEqual(entry.output_price, '0.02/img');
    assert.strictEqual(entry.input_cost, 2_000_000);
    assert.strictEqual(entry.output_cost, 40_000_000);
    assert.strictEqual(entry.total_cost, 42_000_000);
  });

  it('recordCallSuccess 应写入成功日志并更新模型统计', async () => {
    const selection = createSelection({
      input_price: '2/M',
      output_price: '0.02/img',
      avg_latency_ms: 100,
      success_rate: 0.5,
      error_rate: 0.5,
      consecutive_failures: 3,
      cooldown_until: '2026-04-12T00:20:00.000Z',
      status: MODEL_STATUS.OPEN,
      request_count: 2,
      input_usage: 5,
      outpu_usage: 7,
      total_cost: 11,
    });

    const entry = await recordCallSuccess(mockEnv.DB, {
      requestBody: { model: 'result-alias' },
      responseBody: {
        usage: { promptTokens: 1000, completionTokens: 5 },
        images: [{ base64: 'a' }, { base64: 'b' }],
      },
      selection,
      callType: CALL_TYPES.IMAGE_GEN,
      latencyMs: 200,
      now: new Date('2026-04-12T00:00:00.000Z'),
      uuid: () => 'log-success',
    });

    const updatedModel = mockEnv._models.get('m-result');
    assert.strictEqual(entry.total_cost, 42_000_000);
    assert.strictEqual(mockEnv._logs.length, 1);
    assert.strictEqual(mockEnv._logs[0].id, 'log-success');
    assert.strictEqual(mockEnv._logs[0].status, LOG_STATUS.SUCCESS);
    assert.strictEqual(updatedModel.avg_latency_ms, 130);
    assert.ok(Math.abs(updatedModel.success_rate - 0.65) < 1e-12);
    assert.ok(Math.abs(updatedModel.error_rate - 0.35) < 1e-12);
    assert.strictEqual(updatedModel.consecutive_failures, 0);
    assert.strictEqual(updatedModel.cooldown_until, null);
    assert.strictEqual(updatedModel.status, MODEL_STATUS.ACTIVE);
    assert.strictEqual(updatedModel.request_count, 3);
    assert.strictEqual(updatedModel.input_usage, 1005);
    assert.strictEqual(updatedModel.outpu_usage, 9);
    assert.strictEqual(updatedModel.total_cost, 42_000_011);
  });

  it('recordCallFailure 应写入失败日志并按失败次数打开冷却', async () => {
    const selection = createSelection({
      avg_latency_ms: 100,
      success_rate: 0.5,
      error_rate: 0.5,
      consecutive_failures: 1,
      status: MODEL_STATUS.ACTIVE,
      request_count: 2,
    });

    const entry = await recordCallFailure(mockEnv.DB, {
      requestBody: { model: 'result-alias' },
      selection,
      callType: CALL_TYPES.CHAT,
      error: new Error('upstream failed'),
      latencyMs: 250,
      now: new Date('2026-04-12T00:00:00.000Z'),
      uuid: () => 'log-failure',
    });

    const updatedModel = mockEnv._models.get('m-result');
    assert.strictEqual(entry.status, LOG_STATUS.ERROR);
    assert.strictEqual(entry.error_message, 'upstream failed');
    assert.strictEqual(entry.input_quantity, 0);
    assert.strictEqual(entry.total_cost, 0);
    assert.strictEqual(mockEnv._logs[0].id, 'log-failure');
    assert.strictEqual(mockEnv._logs[0].status, LOG_STATUS.ERROR);
    assert.strictEqual(updatedModel.consecutive_failures, 2);
    assert.strictEqual(updatedModel.success_rate, 0.35);
    assert.strictEqual(updatedModel.error_rate, 0.65);
    assert.strictEqual(updatedModel.cooldown_until, '2026-04-12T00:01:00.000Z');
    assert.strictEqual(updatedModel.status, MODEL_STATUS.OPEN);
    assert.strictEqual(updatedModel.request_count, 3);
  });

  it('getCooldownDuration 应按失败次数返回冷却时长', () => {
    assert.strictEqual(getCooldownDuration(1), 0);
    assert.strictEqual(getCooldownDuration(2), 60_000);
    assert.strictEqual(getCooldownDuration(4), 300_000);
    assert.strictEqual(getCooldownDuration(8), 3_600_000);
    assert.strictEqual(getCooldownDuration(24), 86_400_000);
    assert.strictEqual(getCooldownDuration(32), 259_200_000);
  });
});

describe('db-repository: Drizzle 仓储', () => {
  let mockEnv;
  let repo;

  beforeEach(() => {
    mockEnv = createMockEnv();
    repo = createGatewayRepository(mockEnv.DB);
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('应创建渠道及模型，并读取渠道详情', async () => {
    await repo.createChannelWithModels({
      channel: {
        id: 'repo-channel',
        name: 'Repo Channel',
        key: 'repo-channel',
        provider: PROVIDERS.OPENAI,
        api_key: 'sk-repo',
        base_url: '',
        weight: 2,
        created_at: '2026-04-12T00:00:00.000Z',
        updated_at: '2026-04-12T00:00:00.000Z',
      },
      models: [
        {
          code: 'repo-model',
          name: 'Repo Model',
          desc: '',
          aliases: ['repo-alias'],
          callType: CALL_TYPES.CHAT,
          capabilities: [CALL_TYPES.CHAT],
          inputPrice: '1/M',
          outputPrice: '2/M',
          weight: 3,
          headers: { 'x-repo': 'yes' },
        },
      ],
      modelIds: ['repo-model-id'],
      timestamp: '2026-04-12T00:00:00.000Z',
    });

    const channel = await repo.getChannelWithModels('repo-channel');
    assert.strictEqual(channel.key, 'repo-channel');
    assert.strictEqual(channel.models.length, 1);
    assert.strictEqual(channel.models[0].code, 'repo-model');
    assert.strictEqual(channel.models[0].headers, JSON.stringify({ 'x-repo': 'yes' }));
  });

  it('应分页列出渠道并过滤日志', async () => {
    addChannelWithModel(mockEnv, { channelId: 'repo-ch', channelKey: 'repo-key', modelId: 'repo-m', modelCode: 'repo-model' });
    mockEnv._addLog({
      id: 'repo-log-success',
      channel_id: 'repo-ch',
      channel_name: 'Repo Channel',
      model_id: 'repo-m',
      model_code: 'repo-model',
      call_type: CALL_TYPES.CHAT,
      request_model: 'repo-model',
      status: LOG_STATUS.SUCCESS,
      error_message: '',
      latency_ms: 10,
      created_at: '2026-04-12T00:00:00Z',
    });
    mockEnv._addLog({
      id: 'repo-log-error',
      channel_id: 'repo-ch',
      channel_name: 'Repo Channel',
      model_id: 'repo-m',
      model_code: 'repo-model',
      call_type: CALL_TYPES.CHAT,
      request_model: 'repo-model',
      status: LOG_STATUS.ERROR,
      error_message: 'failed',
      latency_ms: 20,
      created_at: '2026-04-13T00:00:00Z',
    });

    const channelsPage = await repo.listChannelsWithModels({ page: 1, limit: 10 });
    const logsPage = await repo.getLogs({ page: 1, limit: 10, channel_key: 'repo-key', status: LOG_STATUS.ERROR });

    assert.strictEqual(channelsPage.total, 1);
    assert.strictEqual(channelsPage.data[0].models.length, 1);
    assert.strictEqual(logsPage.total, 1);
    assert.strictEqual(logsPage.data[0].id, 'repo-log-error');
  });

  it('应按 id 和 code 作用域更新及删除模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'repo-a', channelKey: 'repo-a', modelId: 'repo-ma', modelCode: 'shared' });
    addChannelWithModel(mockEnv, { channelId: 'repo-b', channelKey: 'repo-b', modelId: 'repo-mb', modelCode: 'shared' });

    await repo.updateModelById('repo-ma', { status: MODEL_STATUS.DISABLE });
    assert.strictEqual((await repo.getModelById('repo-ma')).status, MODEL_STATUS.DISABLE);
    assert.strictEqual((await repo.getModelById('repo-mb')).status, MODEL_STATUS.ACTIVE);

    const scopedRows = await repo.updateModelsByCode('shared', { status: MODEL_STATUS.OPEN }, 'repo-b');
    assert.strictEqual(scopedRows.length, 1);
    assert.strictEqual((await repo.getModelById('repo-mb')).status, MODEL_STATUS.OPEN);

    const deletedCount = await repo.deleteModelsByCode('shared', 'repo-b');
    assert.strictEqual(deletedCount, 1);
    assert.strictEqual(await repo.getModelById('repo-mb'), null);
  });
});

describe('渠道 API', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = createApp({
      now: () => new Date('2026-04-12T00:00:00Z'),
      uuid: (() => {
        let index = 0;
        return () => `uuid-${++index}`;
      })(),
    });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('POST /api/channel 应创建渠道和模型', async () => {
    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          name: 'OpenAI',
          key: 'openai',
          provider: PROVIDERS.OPENAI,
          apiKey: 'sk-test',
          baseURL: '',
          weight: 2,
          models: [
            {
              code: 'gpt-4o',
              name: 'GPT-4o',
              callType: CALL_TYPES.CHAT,
              capabilities: [CALL_TYPES.CHAT],
              inputPrice: '1/M',
              outputPrice: '2/M',
              weight: 3,
              headers: { 'x-test': 'yes' },
            },
          ],
        },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.CREATED, JSON.stringify(data));
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.key, 'openai');
    assert.strictEqual(data.data.models.length, 1);
    assert.strictEqual(data.data.models[0].code, 'gpt-4o');
    assert.strictEqual(data.data.models[0].headers, JSON.stringify({ 'x-test': 'yes' }));
  });

  it('POST /api/channel 重复 key 应返回 403', async () => {
    mockEnv._addChannel({
      id: 'existing',
      name: 'Existing',
      key: 'openai',
      provider: PROVIDERS.OPENAI,
      api_key: 'sk-test',
      base_url: '',
      weight: 1,
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel',
        headers: ADMIN_AUTH_HEADERS,
        body: { name: 'OpenAI', key: 'openai', provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.FORBIDDEN);
    assert.strictEqual(data.error, ERROR_MESSAGES.CHANNEL_KEY_ALREADY_EXISTS);
  });

  it('POST /api/channel 请求体字段非法应返回具体原因', async () => {
    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel',
        headers: ADMIN_AUTH_HEADERS,
        body: { name: 'OpenAI', key: 'OpenAI', provider: PROVIDERS.OPENAI, baseURL: '' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.ok(data.error.includes('key:'));
    assert.ok(data.error.includes('apiKey:'));
  });

  it('GET /api/channels 应分页返回渠道和模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-1', modelId: 'm-1' });

    const response = await app.handleRequest(
      createMockRequest({
        pathname: '/api/channels?page=1&limit=10',
        headers: ADMIN_AUTH_HEADERS,
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.total, 1);
    assert.strictEqual(data.data[0].models.length, 1);
  });

  it('GET /api/channel/:id 不存在应返回 404', async () => {
    const response = await app.handleRequest(
      createMockRequest({ pathname: '/api/channel/missing', headers: ADMIN_AUTH_HEADERS }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.NOT_FOUND);
    assert.strictEqual(data.error, ERROR_MESSAGES.CHANNEL_NOT_FOUND);
  });

  it('PUT /api/channel/:id 应支持更新、创建、删除和跳过非法模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-1', modelId: 'm-keep' });
    mockEnv._addModel({
      ...mockEnv._models.get('m-keep'),
      id: 'm-delete',
      code: 'to-delete',
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'PUT',
        pathname: '/api/channel/ch-1',
        headers: ADMIN_AUTH_HEADERS,
        body: {
          name: 'Updated Channel',
          weight: 5,
          deletedModelIds: ['m-delete', 'missing-delete'],
          models: [
            { id: 'm-keep', name: 'Updated Model', aliases: ['alias-1'], headers: { 'x-model': 'yes' } },
            { id: 'missing-model', name: 'Missing Model' },
            { code: 'new-model', name: 'New Model', callType: CALL_TYPES.IMAGE_GEN, capabilities: [CALL_TYPES.IMAGE_GEN] },
            { desc: 'missing required fields' },
          ],
        },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.data.name, 'Updated Channel');
    assert.strictEqual(data.model_changes.updated_count, 1);
    assert.strictEqual(data.model_changes.created_count, 1);
    assert.strictEqual(data.model_changes.deleted_count, 1);
    assert.strictEqual(data.model_changes.skipped.length, 2);
    assert.strictEqual(data.model_changes.delete_skipped.length, 1);
    assert.strictEqual(mockEnv._models.has('m-delete'), false);
    assert.strictEqual(mockEnv._models.get('m-keep').name, 'Updated Model');
  });

  it('DELETE /api/channel/:id 应删除渠道及其模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-1', modelId: 'm-1' });

    const response = await app.handleRequest(
      createMockRequest({ method: 'DELETE', pathname: '/api/channel/ch-1', headers: ADMIN_AUTH_HEADERS }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(mockEnv._channels.has('ch-1'), false);
    assert.strictEqual(mockEnv._models.has('m-1'), false);
  });
});

describe('模型 API', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = createApp({ now: () => new Date('2026-04-12T00:00:00Z'), uuid: () => 'new-model-id' });
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('GET /api/model/:id 应返回模型详情', async () => {
    addChannelWithModel(mockEnv, { modelId: 'm-1' });

    const response = await app.handleRequest(
      createMockRequest({ pathname: '/api/model/m-1', headers: ADMIN_AUTH_HEADERS }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.data.id, 'm-1');
  });

  it('PUT /api/model/:id sync_scope=single 应只更新当前模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-1', modelId: 'm-1', modelCode: 'shared-code' });
    addChannelWithModel(mockEnv, { channelId: 'ch-2', modelId: 'm-2', modelCode: 'shared-code', channelKey: 'second-channel' });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'PUT',
        pathname: '/api/model/m-1',
        headers: ADMIN_AUTH_HEADERS,
        body: { status: MODEL_STATUS.DISABLE, outputPrice: '10/M' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.affected.count, 1);
    assert.strictEqual(mockEnv._models.get('m-1').status, MODEL_STATUS.DISABLE);
    assert.strictEqual(mockEnv._models.get('m-2').status, MODEL_STATUS.ACTIVE);
  });

  it('PUT /api/model/:id sync_scope=by_code + channel_id 应只更新指定渠道同 code 模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-1', modelId: 'm-1', modelCode: 'shared-code' });
    addChannelWithModel(mockEnv, { channelId: 'ch-2', modelId: 'm-2', modelCode: 'shared-code', channelKey: 'second-channel' });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'PUT',
        pathname: '/api/model/m-1?sync_scope=by_code&channel_id=ch-2',
        headers: ADMIN_AUTH_HEADERS,
        body: { status: MODEL_STATUS.DISABLE },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.affected.scope, 'by_code');
    assert.strictEqual(data.affected.count, 1);
    assert.strictEqual(mockEnv._models.get('m-1').status, MODEL_STATUS.ACTIVE);
    assert.strictEqual(mockEnv._models.get('m-2').status, MODEL_STATUS.DISABLE);
  });

  it('DELETE /api/model/:id sync_scope=by_code 应删除同 code 模型', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-1', modelId: 'm-1', modelCode: 'shared-code' });
    addChannelWithModel(mockEnv, { channelId: 'ch-2', modelId: 'm-2', modelCode: 'shared-code', channelKey: 'second-channel' });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'DELETE',
        pathname: '/api/model/m-1?sync_scope=by_code',
        headers: ADMIN_AUTH_HEADERS,
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.affected.count, 2);
    assert.strictEqual(mockEnv._models.size, 0);
  });

  it('非法 sync_scope 应返回 400', async () => {
    addChannelWithModel(mockEnv, { modelId: 'm-1' });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'PUT',
        pathname: '/api/model/m-1?sync_scope=invalid',
        headers: ADMIN_AUTH_HEADERS,
        body: { name: 'Updated' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.ok(data.error.includes('sync_scope'));
  });
});

describe('状态和日志 API', () => {
  let app;
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = createApp();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('GET /status 应返回模型状态字段', async () => {
    addChannelWithModel(mockEnv, {
      channelId: 'ch-status',
      modelId: 'm-status',
      modelCode: 'gpt-4o-mini',
      provider: PROVIDERS.OPENAI_COMPATIBLE,
    });
    Object.assign(mockEnv._models.get('m-status'), {
      request_count: 7,
      input_usage: 11,
      outpu_usage: 13,
      total_cost: 17,
      cooldown_until: '2026-04-12T00:10:00.000Z',
    });

    const response = await app.handleRequest(createMockRequest({ pathname: ROUTES.STATUS }), mockEnv);
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.models.length, 1);
    assert.strictEqual(data.models[0].provider, PROVIDERS.OPENAI_COMPATIBLE);
    assert.strictEqual(data.models[0].request_count, 7);
    assert.strictEqual(data.models[0].outpu_usage, 13);
  });

  it('GET /api/log 应按条件过滤并分页', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-log', channelKey: 'log-channel', modelId: 'm-log' });
    mockEnv._addLog({
      id: 'log-1',
      channel_id: 'ch-log',
      channel_name: 'Log Channel',
      model_id: 'm-log',
      model_code: 'gpt-4o',
      call_type: CALL_TYPES.CHAT,
      request_model: 'gpt-4o',
      status: LOG_STATUS.SUCCESS,
      error_message: '',
      latency_ms: 10,
      created_at: '2026-04-12T00:00:00Z',
    });
    mockEnv._addLog({
      id: 'log-2',
      channel_id: 'ch-log',
      channel_name: 'Log Channel',
      model_id: 'm-log',
      model_code: 'gpt-4o',
      call_type: CALL_TYPES.CHAT,
      request_model: 'gpt-4o',
      status: LOG_STATUS.ERROR,
      error_message: 'failed',
      latency_ms: 20,
      created_at: '2026-04-13T00:00:00Z',
    });

    const response = await app.handleRequest(
      createMockRequest({
        pathname: '/api/log?page=1&limit=10&channel_key=log-channel&model_code=gpt-4o&status=error',
        headers: ADMIN_AUTH_HEADERS,
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.total, 1);
    assert.strictEqual(data.data[0].id, 'log-2');
  });

  it('GET /api/log 非法分页参数应返回 400', async () => {
    const response = await app.handleRequest(
      createMockRequest({ pathname: '/api/log?page=0&limit=200', headers: ADMIN_AUTH_HEADERS }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.BAD_REQUEST);
    assert.ok(data.error.includes('page:'));
    assert.ok(data.error.includes('limit:'));
  });
});

describe('上游模型列表 API', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    mockEnv._clear();
  });

  it('GET /api/channel/:id/models 应从 OpenAI 上游获取模型列表', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-openai', provider: PROVIDERS.OPENAI });
    const app = createApp({
      fetch: createMockFetch({
        'api.openai.com/v1/models': {
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' },
            { id: 'gpt-4o-mini', object: 'model', created: 1700000001, owned_by: 'openai' },
          ],
        },
      }),
    });

    const response = await app.handleRequest(
      createMockRequest({ pathname: '/api/channel/ch-openai/models', headers: ADMIN_AUTH_HEADERS }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.deepStrictEqual(data.data.map((model) => model.id), ['gpt-4o', 'gpt-4o-mini']);
  });

  it('POST /api/channel/models 应按连接参数获取模型列表', async () => {
    const app = createApp({
      fetch: createMockFetch({
        'api.openai.com/v1/models': {
          object: 'list',
          data: [{ id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' }],
        },
      }),
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel/models',
        headers: ADMIN_AUTH_HEADERS,
        body: { provider: PROVIDERS.OPENAI, apiKey: 'sk-test', baseURL: '' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data[0].id, 'gpt-4o');
  });

  it('POST /api/channel/models 对 Exacg 应返回空模型列表且不请求上游', async () => {
    const calls = [];
    const app = createApp({
      fetch: createMockFetch({}, (url) => calls.push(url)),
    });

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel/models',
        headers: ADMIN_AUTH_HEADERS,
        body: { provider: PROVIDERS.EXACG, apiKey: 'exacg-key', baseURL: 'https://exacg.example.com/api/v1' },
      }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK, JSON.stringify(data));
    assert.strictEqual(data.success, true);
    assert.deepStrictEqual(data.data, []);
    assert.strictEqual(calls.length, 0);
  });

  it('未知 provider 当前应返回 success=false', async () => {
    const app = createApp();

    const response = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel/models',
        headers: ADMIN_AUTH_HEADERS,
        body: { provider: 'unknown-provider', apiKey: 'key', baseURL: '' },
      }),
      mockEnv,
    );
    const data = await response.json();
    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, false);
    assert.deepStrictEqual(data.data, []);
    assert.ok(data.error.includes('Unsupported provider'));
  });

  it('自定义 baseURL 已包含版本路径时应追加 /models，否则追加兼容模型列表路径', async () => {
    const calls = [];
    const app = createApp({
      fetch: createMockFetch({}, (url) => calls.push(url)),
    });

    await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel/models',
        headers: ADMIN_AUTH_HEADERS,
        body: { provider: PROVIDERS.OPENAI_COMPATIBLE, apiKey: 'key', baseURL: 'https://custom.example.com/v2' },
      }),
      mockEnv,
    );
    await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel/models',
        headers: ADMIN_AUTH_HEADERS,
        body: { provider: PROVIDERS.OPENAI_COMPATIBLE, apiKey: 'key', baseURL: 'https://custom.example.com/api' },
      }),
      mockEnv,
    );

    assert.ok(calls[0].endsWith('/v2/models'));
    assert.ok(calls[1].endsWith('/api/v1/models'));
  });

  it('上游请求失败应返回 success=false 和错误信息', async () => {
    addChannelWithModel(mockEnv, { channelId: 'ch-fail', provider: PROVIDERS.OPENAI });
    const app = createApp({
      fetch: createMockFetch({
        'api.openai.com/v1/models': { ok: false, status: 401, data: { error: 'invalid key' } },
      }),
    });

    const response = await app.handleRequest(
      createMockRequest({ pathname: '/api/channel/ch-fail/models', headers: ADMIN_AUTH_HEADERS }),
      mockEnv,
    );
    const data = await response.json();

    assert.strictEqual(response.status, HTTP_STATUS.OK);
    assert.strictEqual(data.success, false);
    assert.deepStrictEqual(data.data, []);
    assert.ok(data.error.includes('401'));
  });

  it('缺少 apiKey 或请求体解析失败应返回 400', async () => {
    const app = createApp();
    const missingKeyResponse = await app.handleRequest(
      createMockRequest({
        method: 'POST',
        pathname: '/api/channel/models',
        headers: ADMIN_AUTH_HEADERS,
        body: { provider: PROVIDERS.OPENAI, baseURL: '' },
      }),
      mockEnv,
    );
    const missingKeyData = await missingKeyResponse.json();

    assert.strictEqual(missingKeyResponse.status, HTTP_STATUS.BAD_REQUEST);
    assert.ok(missingKeyData.error.includes('apiKey:'));

    const malformedRequest = {
      method: 'POST',
      url: 'https://example.com/api/channel/models',
      headers: { get: (key) => (String(key).toLowerCase() === 'authorization' ? ADMIN_AUTH_HEADERS.authorization : undefined) },
      json: async () => {
        throw new Error('Malformed JSON payload');
      },
      formData: async () => new Map(),
    };
    const malformedResponse = await app.handleRequest(malformedRequest, mockEnv);
    const malformedData = await malformedResponse.json();

    assert.strictEqual(malformedResponse.status, HTTP_STATUS.BAD_REQUEST);
    assert.strictEqual(malformedData.error, `${ERROR_MESSAGES.INVALID_REQUEST_BODY}: Malformed JSON payload`);
  });
});
