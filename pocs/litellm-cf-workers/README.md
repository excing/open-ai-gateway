# LiteLLM Cloudflare Python Workers POC

这个目录是独立可部署 POC，用于验证 `FastAPI + LiteLLM` 是否能直接运行在 Cloudflare Python Workers 上。

## 部署

```bash
cd pocs/litellm-cf-workers
uv run pywrangler deploy
```

## Secrets

```bash
cd pocs/litellm-cf-workers
npx wrangler secret put OPENAI_API_KEY
# 可选：设置后 /v1/chat/completions 需要 Authorization: Bearer <ADMIN_KEY>
npx wrangler secret put ADMIN_KEY
```

## 验证

```bash
curl https://你的-poc-worker域名/healthz
curl https://你的-poc-worker域名/litellm/import
curl https://你的-poc-worker域名/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Say OK"}]}'
```

如果 `/healthz` 成功但 `/litellm/import` 失败，说明 Python Worker 和 FastAPI 可用，但 LiteLLM 依赖在 Workers/Pyodide 环境中不兼容。
