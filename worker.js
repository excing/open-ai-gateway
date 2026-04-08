/**
 * Cloudflare Workers 脚本
 * 主要功能, 使用统一的 API 接口请求不同 AI 渠道的模型
 * - 除特殊说明外, 所有请求默认都需要鉴权
 * 
 * ### 渠道数据结构
 *
 * ```ts
interface Channel {
  id: string;
  name: string;
  key: string;
  provider: string; // AI 平台, openai/openai-compatible, google/gemini, anthropic/claude, openrouter, pollinations, 默认为 openai
  apiKey: string;
  baseURL: string;
  models: {
    id: string;
    code: string;
    name: string;
    desc: string;
    aliases: string[]; // 模型别名
    callType: string; // 请求该模型时需要调用的接口类型, 支持 chat, image_gen, audio_gen, video_gen, transcribe, embedding, 默认 chat
    capabilities: string[]; // 该模型的能力, 支持 chat, image_in, image_out, audio_in, audio_out, video_in, video_out, embedding
    cost: string; // 成本, 值格式, /img = flat rate per image, /M = per million tokens, /sec = per second of video/audio, /req = flat rate per request
    status: string; // 状态, 值有: active, open, disable. action: 正常参与调度, open: 处于冷却期, 完全不参与调度, disable: 人工禁用, 默认 active
    weight: float; // 权重, 要优先选择该模型
    avgLatencyMs: float; // 模型平均响应时间, 值越大, 选中的概率越小
    successRate: float; // 请求平均成功率, 值越大, 选中的概率越大
    errorRate: float; // 请求平均失败率
    consecutiveFailures: number; // 最近连续失败次数, 但 `2<=` 时进入冷却期, 2 ~ 4 次冷却时间 60s, 4 ~ 8 次冷却时间 300s, 8 ~ 24次冷却时间 1h, 24 ~ 32次冷却时间 1day, 32<=次冷却时间 3day
    lastUpdated: timestamp; // 最近更新时间
    headers: Record<string, any>; // 模型请求时额外的头信息
  }[];
}
 * ```
 *  
 * @param {*} request 
 * 
 * ### /v1/* 
 * OpenAI /v1 请求格式, 完全兼容模式, 支持 `x-channel-id`, 表示该请求走指定的渠道代理
 * 
 * - `/v1/chat/completions`: 聊天
 * - `/v1/images/generations`: 图片生成
 * - `/v1/video/generations`: 视频生成
 * - `/v1/audio/speech`: 语音生成
 * - `/v1/audio/transcriptions`: 语音识别
 * - `/v1/embeddings`: 向量化
 * - `/v1/models`: 模型列表
 * 
 * ### /api/*
 * 管理员操作
 * 
 * #### POST /api/channel
 * 提交一个AI渠道
 * 
 * #### GET/DELETE/PUT /api/channel/{id}
 * 获取/删除/更新一个指定的AI渠道
 * 
 * #### GET /api/channels
 * 获取渠道列表, 支持分页
 * 
 * #### GET/DELETE/PUT /api/model/{id}
 * 获取/删除/更新一个指定的AI模型
 * 
 * #### GET /api/log
 * 获取AI请求日志, 支持分页
 * 
 * #### GET /status
 * 获取所有模型的状态, 不需要鉴权
 * 
 * @param {*} env ### 环境变量
 * - ADMIN_KEY 管理员使用秘钥
 */
async function handleRequest(request, env) {

}

const worker = {
  fetch: handleRequest,
};

export default worker;
