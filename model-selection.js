import { drizzle } from 'drizzle-orm/d1';
import { and, eq, getTableColumns, isNull, like, lt, ne, or } from 'drizzle-orm';
import { channelModels, channels } from './db-schema.js';

const CALL_TYPES = {
  CHAT: 'chat',
  IMAGE_GEN: 'image_gen',
  AUDIO_GEN: 'audio_gen',
  VIDEO_GEN: 'video_gen',
  TRANSCRIBE: 'transcribe',
  EMBEDDING: 'embedding',
};

const MODEL_STATUS = {
  ACTIVE: 'active',
  OPEN: 'open',
  DISABLE: 'disable',
};

const SCORE_WEIGHTS = {
  WEIGHT_FACTOR: 10,
  CHANNEL_WEIGHT_FACTOR: 10,
  SUCCESS_RATE_FACTOR: 50,
  LATENCY_PENALTY: 0.01,
  FAILURE_PENALTY: 20,
};

function calculateModelScore(modelRow) {
  const channelWeight = modelRow.ch_weight ?? 1;
  return (
    modelRow.weight * SCORE_WEIGHTS.WEIGHT_FACTOR +
    channelWeight * SCORE_WEIGHTS.CHANNEL_WEIGHT_FACTOR +
    modelRow.success_rate * SCORE_WEIGHTS.SUCCESS_RATE_FACTOR -
    modelRow.avg_latency_ms * SCORE_WEIGHTS.LATENCY_PENALTY -
    modelRow.consecutive_failures * SCORE_WEIGHTS.FAILURE_PENALTY
  );
}

async function selectChannelModels(db, { model, callType, channelId = '', now = new Date() }) {
  if (!model || !callType) return [];

  const orm = drizzle(db);
  const modelColumns = getTableColumns(channelModels);
  const conditions = [
    or(eq(channelModels.code, model), like(channelModels.aliases, `%\"${model}\"%`)),
    ne(channelModels.status, MODEL_STATUS.DISABLE),
    or(isNull(channelModels.cooldown_until), lt(channelModels.cooldown_until, now.toISOString())),
  ];
  if (channelId) conditions.push(eq(channelModels.channel_id, channelId));

  const results = await orm
    .select({
      ...modelColumns,
      ch_id: channels.id,
      ch_name: channels.name,
      ch_key: channels.key,
      provider: channels.provider,
      api_key: channels.api_key,
      base_url: channels.base_url,
      ch_weight: channels.weight,
    })
    .from(channelModels)
    .innerJoin(channels, eq(channelModels.channel_id, channels.id))
    .where(and(...conditions))
    .all();

  if (!results.length) return [];

  return results
    .filter((row) => row.call_type === callType)
    .map((row) => ({
      channel: {
        id: row.ch_id,
        name: row.ch_name,
        key: row.ch_key,
        provider: row.provider,
        api_key: row.api_key,
        base_url: row.base_url,
      },
      model: row,
      score: calculateModelScore(row),
    }))
    .sort((a, b) => b.score - a.score);
}

export {
  CALL_TYPES,
  MODEL_STATUS,
  SCORE_WEIGHTS,
  calculateModelScore,
  selectChannelModels,
};
