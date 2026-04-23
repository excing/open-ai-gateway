CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'openai',
  api_key TEXT NOT NULL,
  base_url TEXT DEFAULT '',
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_models (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  "desc" TEXT DEFAULT '',
  aliases TEXT DEFAULT '[]',
  call_type TEXT NOT NULL DEFAULT 'chat',
  capabilities TEXT DEFAULT '["chat"]',
  input_cost TEXT DEFAULT '0',
  output_cost TEXT DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'active',
  weight REAL NOT NULL DEFAULT 1.0,
  avg_latency_ms REAL NOT NULL DEFAULT 0.0,
  success_rate REAL NOT NULL DEFAULT 1.0,
  error_rate REAL NOT NULL DEFAULT 0.0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT DEFAULT NULL,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  headers TEXT DEFAULT '{}',
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_code TEXT NOT NULL,
  call_type TEXT NOT NULL,
  request_model TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  input_quantity INTEGER DEFAULT 0,
  output_quantity INTEGER DEFAULT 0,
  input_price TEXT DEFAULT '0',
  output_price TEXT DEFAULT '0',
  input_cost INTEGER DEFAULT 0,
  output_cost INTEGER DEFAULT 0,
  total_cost INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channel_models_channel_id ON channel_models(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_models_code ON channel_models(code);
CREATE INDEX IF NOT EXISTS idx_channel_models_status ON channel_models(status);
CREATE INDEX IF NOT EXISTS idx_channel_models_call_type ON channel_models(call_type);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_channel_id ON request_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_model_id ON request_logs(model_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);
