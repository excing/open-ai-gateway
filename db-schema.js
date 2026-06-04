import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  provider: text('provider').notNull().default('openai'),
  api_key: text('api_key').notNull(),
  base_url: text('base_url').default(''),
  weight: real('weight').notNull().default(1.0),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

const channelModels = sqliteTable('channel_models', {
  id: text('id').primaryKey(),
  channel_id: text('channel_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  desc: text('desc').default(''),
  aliases: text('aliases').default('[]'),
  call_type: text('call_type').notNull().default('chat'),
  capabilities: text('capabilities').default('["chat"]'),
  input_price: text('input_price').default('0'),
  output_price: text('output_price').default('0'),
  status: text('status').notNull().default('active'),
  weight: real('weight').notNull().default(1.0),
  avg_latency_ms: real('avg_latency_ms').notNull().default(0.0),
  success_rate: real('success_rate').notNull().default(1.0),
  error_rate: real('error_rate').notNull().default(0.0),
  consecutive_failures: integer('consecutive_failures').notNull().default(0),
  cooldown_until: text('cooldown_until'),
  request_count: integer('request_count').notNull().default(0),
  input_usage: integer('input_usage').notNull().default(0),
  outpu_usage: integer('outpu_usage').notNull().default(0),
  total_cost: integer('total_cost').notNull().default(0),
  last_updated: text('last_updated').notNull(),
  headers: text('headers').default('{}'),
});

const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  channel_id: text('channel_id').notNull(),
  channel_name: text('channel_name').notNull(),
  model_id: text('model_id').notNull(),
  model_code: text('model_code').notNull(),
  call_type: text('call_type').notNull(),
  request_model: text('request_model').notNull(),
  status: text('status').notNull(),
  error_message: text('error_message').default(''),
  latency_ms: integer('latency_ms').notNull().default(0),
  input_quantity: integer('input_quantity').default(0),
  output_quantity: integer('output_quantity').default(0),
  input_price: text('input_price').default('0'),
  output_price: text('output_price').default('0'),
  input_cost: integer('input_cost').default(0),
  output_cost: integer('output_cost').default(0),
  total_cost: integer('total_cost').default(0),
  created_at: text('created_at').notNull(),
});

export { channelModels, channels, requestLogs };
