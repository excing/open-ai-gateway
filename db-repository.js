import { drizzle } from 'drizzle-orm/d1';
import { and, count, desc, eq, getTableColumns, gte, lte } from 'drizzle-orm';
import { channelModels, channels, requestLogs } from './db-schema.js';
import { CALL_TYPES, MODEL_STATUS } from './model-selection.js';

const toDefinedObject = (input) => Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
const toNullable = (row) => row ?? null;

function toModelInsertRow(id, channelId, model, timestamp) {
  return {
    id,
    channel_id: channelId,
    code: model.code,
    name: model.name,
    desc: model.desc ?? '',
    aliases: JSON.stringify(model.aliases || []),
    call_type: model.callType || CALL_TYPES.CHAT,
    capabilities: JSON.stringify(model.capabilities || []),
    input_price: model.inputPrice ?? '0',
    output_price: model.outputPrice ?? '0',
    status: model.status || MODEL_STATUS.ACTIVE,
    weight: model.weight ?? 1,
    avg_latency_ms: 0,
    success_rate: 1,
    error_rate: 0,
    consecutive_failures: 0,
    cooldown_until: null,
    request_count: 0,
    input_usage: 0,
    outpu_usage: 0,
    total_cost: 0,
    last_updated: timestamp,
    headers: JSON.stringify(model.headers || {}),
  };
}

function createGatewayRepository(d1) {
  const db = drizzle(d1);

  async function getChannelById(id) {
    return toNullable(await db.select().from(channels).where(eq(channels.id, id)).get());
  }

  async function getChannelByKey(key) {
    return toNullable(await db.select().from(channels).where(eq(channels.key, key)).get());
  }

  async function getModelsByChannelId(channelId) {
    return db.select().from(channelModels).where(eq(channelModels.channel_id, channelId)).all();
  }

  async function createChannelWithModels({ channel, models, modelIds, timestamp }) {
    await db.insert(channels).values(channel).run();
    await createModels(channel.id, models, modelIds, timestamp);
  }

  async function createModels(channelId, models, modelIds, timestamp) {
    if (!models.length) return;
    const rows = models.map((model, index) => toModelInsertRow(modelIds[index], channelId, model, timestamp));
    await db.insert(channelModels).values(rows).run();
  }

  async function getChannelWithModels(id) {
    const channel = await getChannelById(id);
    if (!channel) return null;
    return { ...channel, models: await getModelsByChannelId(id) };
  }

  async function listChannelsWithModels({ page, limit }) {
    const [{ total = 0 } = {}] = await db.select({ total: count() }).from(channels).all();
    const rows = await db
      .select()
      .from(channels)
      .orderBy(desc(channels.created_at))
      .limit(limit)
      .offset((page - 1) * limit)
      .all();
    const data = [];
    for (const channel of rows) {
      data.push({ ...channel, models: await getModelsByChannelId(channel.id) });
    }
    return { data, total: Number(total) };
  }

  async function updateChannel(id, updates) {
    await db.update(channels).set(toDefinedObject(updates)).where(eq(channels.id, id)).run();
  }

  async function deleteChannel(id) {
    await db.delete(channelModels).where(eq(channelModels.channel_id, id)).run();
    await db.delete(channels).where(eq(channels.id, id)).run();
  }

  async function getModelById(id) {
    return toNullable(await db.select().from(channelModels).where(eq(channelModels.id, id)).get());
  }

  async function getModelsByCode(code, channelId = '') {
    const conditions = [eq(channelModels.code, code)];
    if (channelId) conditions.push(eq(channelModels.channel_id, channelId));
    return db.select().from(channelModels).where(and(...conditions)).all();
  }

  async function updateModelById(id, updates) {
    await db.update(channelModels).set(toDefinedObject(updates)).where(eq(channelModels.id, id)).run();
  }

  async function updateModelsByCode(code, updates, channelId = '') {
    const conditions = [eq(channelModels.code, code)];
    if (channelId) conditions.push(eq(channelModels.channel_id, channelId));
    await db.update(channelModels).set(toDefinedObject(updates)).where(and(...conditions)).run();
    return getModelsByCode(code, channelId);
  }

  async function deleteModelById(id) {
    await db.delete(channelModels).where(eq(channelModels.id, id)).run();
  }

  async function deleteModelsByCode(code, channelId = '') {
    const rows = await getModelsByCode(code, channelId);
    const conditions = [eq(channelModels.code, code)];
    if (channelId) conditions.push(eq(channelModels.channel_id, channelId));
    await db.delete(channelModels).where(and(...conditions)).run();
    return rows.length;
  }

  async function getLogs({ page, limit, channel_key, model_code, status, start_date, end_date }) {
    const conditions = [];
    if (channel_key) {
      const channel = await getChannelByKey(channel_key);
      if (!channel) return { data: [], total: 0 };
      conditions.push(eq(requestLogs.channel_id, channel.id));
    }
    if (model_code) conditions.push(eq(requestLogs.model_code, model_code));
    if (status) conditions.push(eq(requestLogs.status, status));
    if (start_date) conditions.push(gte(requestLogs.created_at, start_date));
    if (end_date) conditions.push(lte(requestLogs.created_at, end_date));

    const whereClause = conditions.length ? and(...conditions) : undefined;
    const [{ total = 0 } = {}] = await db.select({ total: count() }).from(requestLogs).where(whereClause).all();
    const data = await db
      .select()
      .from(requestLogs)
      .where(whereClause)
      .orderBy(desc(requestLogs.created_at))
      .limit(limit)
      .offset((page - 1) * limit)
      .all();
    return { data, total: Number(total) };
  }

  async function getStatusRows() {
    const modelColumns = getTableColumns(channelModels);
    return db
      .select({
        ...modelColumns,
        channel_name: channels.name,
        provider: channels.provider,
      })
      .from(channelModels)
      .innerJoin(channels, eq(channelModels.channel_id, channels.id))
      .all();
  }

  return {
    createChannelWithModels,
    createModels,
    deleteChannel,
    deleteModelById,
    deleteModelsByCode,
    getChannelById,
    getChannelByKey,
    getChannelWithModels,
    getLogs,
    getModelById,
    getModelsByChannelId,
    getModelsByCode,
    getStatusRows,
    listChannelsWithModels,
    updateChannel,
    updateModelById,
    updateModelsByCode,
  };
}

export { createGatewayRepository };
