import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { channelModels, requestLogs } from './db-schema.js';
import { CALL_TYPES, MODEL_STATUS } from './model-selection.js';
import { getMp3Duration, getMp4Duration } from './media-utils.js';

const LOG_STATUS = {
  SUCCESS: 'success',
  ERROR: 'error',
};

const COST_UNITS = {
  IMAGE: '/img',
  MILLION: '/M',
  SECOND: '/sec',
  REQUEST: '/req',
};

const COST_SCALE_FACTOR = 1_000_000_000;
const EMA_ALPHA = 0.3;
const DEFAULT_PROVIDER_ERROR = 'Upstream AI provider returned an error';

const COOLDOWN_TIERS = [
  { minFailures: 2, maxFailures: 4, durationMs: 60_000 },
  { minFailures: 4, maxFailures: 8, durationMs: 300_000 },
  { minFailures: 8, maxFailures: 24, durationMs: 3_600_000 },
  { minFailures: 24, maxFailures: 32, durationMs: 86_400_000 },
  { minFailures: 32, maxFailures: Infinity, durationMs: 259_200_000 },
];

const defaultUuid = () => crypto.randomUUID();
const getNow = (now) => now || new Date();

function toSafeNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function getUsageTokens(usage) {
  const inputTokens = Number(usage?.inputTokens ?? usage?.promptTokens ?? 0);
  const outputTokens = Number(usage?.outputTokens ?? usage?.completionTokens ?? 0);
  const totalTokens = Number(usage?.totalTokens ?? inputTokens + outputTokens);
  return {
    input: Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0,
    output: Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0,
    total: Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0,
  };
}

function parsePricingConfig(configValue) {
  if (typeof configValue !== 'string') return [];
  return configValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === '0') return { raw: part, price: 0, unit: null };
      const [priceText, rawUnit] = part.split('/');
      const price = toSafeNumber(priceText, NaN);
      const unit = rawUnit ? `/${String(rawUnit).toLowerCase()}` : null;
      if (!Number.isFinite(price) || price < 0) return null;
      if (unit !== '/req' && unit !== '/sec' && unit !== '/img' && unit !== '/m') return null;
      return {
        raw: part,
        price: unit === '/m' ? price / 1_000_000 : price,
        unit: unit === '/m' ? COST_UNITS.MILLION : unit,
      };
    })
    .filter(Boolean);
}

function choosePricingRule(pricingRules, preferredUnits) {
  for (const unit of preferredUnits) {
    const found = pricingRules.find((rule) => rule.unit === unit);
    if (found) return found;
  }
  return pricingRules[0] || { raw: '0', price: 0, unit: null };
}

function calculateBillableQuantities(inputUnit, outputUnit, context) {
  const { usageTokens, inputAudioDuration, outputImageCount, outputAudioDuration, outputVideoDuration } = context;
  const input = inputUnit === COST_UNITS.SECOND ? inputAudioDuration : usageTokens.input;

  let output = usageTokens.output;
  if (outputUnit === COST_UNITS.REQUEST) output = 1;
  if (outputUnit === COST_UNITS.IMAGE) output = outputImageCount;
  if (outputUnit === COST_UNITS.SECOND) output = outputAudioDuration + outputVideoDuration;

  return { input, output };
}

function buildBillingContext(requestBody, responseBody, callType) {
  return {
    usageTokens: getUsageTokens(responseBody?.usage),
    inputAudioDuration: callType === CALL_TYPES.TRANSCRIBE && requestBody?.audio
      ? getMp3Duration(requestBody.audio)
      : 0,
    outputImageCount: responseBody?.images ? responseBody.images.length : 0,
    outputAudioDuration: responseBody?.audio ? getMp3Duration(responseBody.audio.uint8Array) : 0,
    outputVideoDuration: responseBody?.video ? getMp4Duration(responseBody.video.uint8Array) : 0,
  };
}

function buildSuccessLogEntry({ requestBody, responseBody, selection, callType, latencyMs }) {
  const preferredUnits = [COST_UNITS.REQUEST, COST_UNITS.IMAGE, COST_UNITS.SECOND, COST_UNITS.MILLION];
  const inputRule = choosePricingRule(parsePricingConfig(selection.model.input_price), preferredUnits);
  const outputRule = choosePricingRule(parsePricingConfig(selection.model.output_price), preferredUnits);
  const quantities = calculateBillableQuantities(
    inputRule.unit,
    outputRule.unit,
    buildBillingContext(requestBody, responseBody, callType),
  );
  const inputCost = Math.round(inputRule.price * quantities.input * COST_SCALE_FACTOR);
  const outputCost = Math.round(outputRule.price * quantities.output * COST_SCALE_FACTOR);

  return {
    channel_id: selection.channel.id,
    channel_name: selection.channel.name,
    model_id: selection.model.id,
    model_code: selection.model.code,
    call_type: callType,
    request_model: requestBody?.model || selection.model.code,
    status: LOG_STATUS.SUCCESS,
    error_message: '',
    latency_ms: latencyMs,
    input_quantity: quantities.input,
    output_quantity: quantities.output,
    input_price: inputRule.raw,
    output_price: outputRule.raw,
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: inputCost + outputCost,
  };
}

function buildFailureLogEntry({ requestBody, selection, callType, error, latencyMs }) {
  return {
    channel_id: selection.channel.id,
    channel_name: selection.channel.name,
    model_id: selection.model.id,
    model_code: selection.model.code,
    call_type: callType,
    request_model: requestBody?.model || selection.model.code,
    status: LOG_STATUS.ERROR,
    error_message: error?.message || DEFAULT_PROVIDER_ERROR,
    latency_ms: latencyMs,
    input_quantity: 0,
    output_quantity: 0,
    input_price: '0',
    output_price: '0',
    input_cost: 0,
    output_cost: 0,
    total_cost: 0,
  };
}

function getCooldownDuration(failures) {
  for (const tier of COOLDOWN_TIERS) {
    if (failures >= tier.minFailures && failures < tier.maxFailures) {
      return tier.durationMs;
    }
  }
  return 0;
}

async function writeLog(db, entry, now, uuid) {
  await drizzle(db).insert(requestLogs).values({ id: uuid(), ...entry, created_at: now.toISOString() }).run();
}

async function updateSuccessStats(db, entry, now) {
  const orm = drizzle(db);
  const model = await orm.select().from(channelModels).where(eq(channelModels.id, entry.model_id)).get();
  if (!model) return;

  const avgLatency = toSafeNumber(model.avg_latency_ms, 0) * (1 - EMA_ALPHA) + entry.latency_ms * EMA_ALPHA;
  const successRate = toSafeNumber(model.success_rate, 1) * (1 - EMA_ALPHA) + EMA_ALPHA;
  const errorRate = 1 - successRate;
  const requestCount = toSafeNumber(model.request_count, 0) + 1;
  const inputUsage = toSafeNumber(model.input_usage, 0) + toSafeNumber(entry.input_quantity, 0);
  const outputUsage = toSafeNumber(model.outpu_usage, 0) + toSafeNumber(entry.output_quantity, 0);
  const totalCost = toSafeNumber(model.total_cost, 0) + toSafeNumber(entry.total_cost, 0);
  await orm
    .update(channelModels)
    .set({
      avg_latency_ms: avgLatency,
      success_rate: successRate,
      error_rate: errorRate,
      consecutive_failures: 0,
      cooldown_until: null,
      status: MODEL_STATUS.ACTIVE,
      request_count: requestCount,
      input_usage: inputUsage,
      outpu_usage: outputUsage,
      total_cost: totalCost,
      last_updated: now.toISOString(),
    })
    .where(eq(channelModels.id, entry.model_id))
    .run();
}

async function updateFailureStats(db, modelId, now) {
  const orm = drizzle(db);
  const model = await orm.select().from(channelModels).where(eq(channelModels.id, modelId)).get();
  if (!model) return;

  const failures = toSafeNumber(model.consecutive_failures, 0) + 1;
  const successRate = toSafeNumber(model.success_rate, 1) * (1 - EMA_ALPHA);
  const errorRate = 1 - successRate;
  const cooldownMs = getCooldownDuration(failures);
  const cooldownUntil = cooldownMs > 0 ? new Date(now.getTime() + cooldownMs).toISOString() : null;
  const status = cooldownMs > 0 ? MODEL_STATUS.OPEN : model.status;
  const requestCount = toSafeNumber(model.request_count, 0) + 1;
  await orm
    .update(channelModels)
    .set({
      consecutive_failures: failures,
      success_rate: successRate,
      error_rate: errorRate,
      cooldown_until: cooldownUntil,
      status,
      request_count: requestCount,
      last_updated: now.toISOString(),
    })
    .where(eq(channelModels.id, modelId))
    .run();
}

async function recordCallSuccess(db, input) {
  const now = getNow(input.now);
  const uuid = input.uuid || defaultUuid;
  const entry = buildSuccessLogEntry(input);
  await Promise.all([
    writeLog(db, entry, now, uuid),
    updateSuccessStats(db, entry, now),
  ]);
  return entry;
}

async function recordCallFailure(db, input) {
  const now = getNow(input.now);
  const uuid = input.uuid || defaultUuid;
  const entry = buildFailureLogEntry(input);
  await Promise.all([
    writeLog(db, entry, now, uuid),
    updateFailureStats(db, entry.model_id, now),
  ]);
  return entry;
}

export {
  COST_SCALE_FACTOR,
  COST_UNITS,
  EMA_ALPHA,
  LOG_STATUS,
  buildFailureLogEntry,
  buildSuccessLogEntry,
  getCooldownDuration,
  recordCallFailure,
  recordCallSuccess,
};
