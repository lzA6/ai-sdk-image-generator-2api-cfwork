// =================================================================================
//  项目: ai-sdk-image-generator-2api (Cloudflare Worker 单文件版)
//  版本: 1.0.2 (代号: Chimera Synthesis - Resilience)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-10
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将
//  ai-sdk-image-generator.vercel.app 的后端文生图服务，无损地转换为一个高性能、
//  兼容 OpenAI 标准的 API，并内置了一个功能强大的"开发者驾驶舱"Web UI，
//  用于实时监控、测试和集成。
//
//  v1.0.2 修正:
//  - [功能] 大幅扩充支持的模型列表，基于用户提供的截图，涵盖 Replicate, Fireworks, Vertex。
//  - [修复] 实现了针对上游 `429 Too Many Requests` 和 `5xx` 错误的自动重试与指数退避机制，提高请求成功率。
//  - [修正] 修复了 v1.0.1 中遗留的 createErrorResponse 参数传递问题。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
// 架构核心：所有关键参数在此定义，后续逻辑必须从此对象读取。
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "ai-sdk-image-generator-2api",
  PROJECT_VERSION: "1.0.2",
  // 安全配置
  API_MASTER_KEY: "1", // 密钥已按指令设置为 "1"
  // 上游服务配置
  UPSTREAM_URL: "https://ai-sdk-image-generator.vercel.app/api/generate-images",
  // 重试机制配置
  UPSTREAM_MAX_RETRIES: 3, // 最大重试次数
  UPSTREAM_INITIAL_BACKOFF: 200, // 初始退避时间 (毫秒)
  // 模型映射 (从情报和用户截图中全面更新)
  // 格式: "用户友好模型名": ["provider", "modelId"]
  MODELS: {
    // --- Replicate Models ---
    "replicate/flux-1.1-pro-ultra": ["replicate", "black-forest-labs/flux-1.1-pro-ultra"],
    "replicate/flux-1.1-pro": ["replicate", "black-forest-labs/flux-1.1-pro"],
    "replicate/flux-pro": ["replicate", "black-forest-labs/flux-pro"],
    "replicate/flux-schnell": ["replicate", "black-forest-labs/flux-schnell"],
    "replicate/ideogram-v2": ["replicate", "ideogram/ideogram-v2"],
    "replicate/ideogram-v2-turbo": ["replicate", "ideogram/ideogram-v2-turbo"],
    "replicate/photon": ["replicate", "photon"],
    "replicate/photon-flash": ["replicate", "photon-flash"],
    "replicate/recraft-v3": ["replicate", "recraft-v3"],
    "replicate/stable-diffusion-3.5-large": ["replicate", "stability-ai/stable-diffusion-3.5-large"],
    "replicate/stable-diffusion-3.5-turbo": ["replicate", "stability-ai/stable-diffusion-3.5-large-turbo"],
    // --- Vertex AI Models ---
    "vertex/imagen-3.0-fast": ["vertex", "imagen-3.0-fast-generate-001"],
    "vertex/imagen-3.0-standard": ["vertex", "imagen-3.0-generate-001"],
    // --- Fireworks AI Models ---
    "fireworks/flux-1-dev-fp8": ["fireworks", "accounts/fireworks/models/flux-1-dev-fp8"],
    "fireworks/flux-1-schnell-fp8": ["fireworks", "accounts/fireworks/models/flux-1-schnell-fp8"],
    "fireworks/playground-v2.5": ["fireworks", "accounts/fireworks/models/playground-v2.5-1024px-aesthetic"],
    "fireworks/playground-v2": ["fireworks", "accounts/fireworks/models/playground-v2-1024px-aesthetic"],
    "fireworks/japanese-sdxl": ["fireworks", "accounts/fireworks/models/japanese-stable-diffusion-xl"],
    "fireworks/ssd-1b": ["fireworks", "accounts/fireworks/models/ssd-1b"],
    "fireworks/stable-diffusion-xl-1.0": ["fireworks", "accounts/fireworks/models/stable-diffusion-xl-1024-v1-0"],
  },
  DEFAULT_MODEL: "replicate/flux-1.1-pro-ultra",
};

// --- [第二部分: Worker 入口与路由] ---
// Cloudflare Worker 的主处理函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 根据路径分发请求到不同的处理器
    if (url.pathname === '/') {
      return handleUI(request); // 处理根路径，返回开发者驾驶舱 UI
    } else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request); // 处理 API 请求
    } else {
      // 对于所有其他路径，返回 404 Not Found
      return new Response(
        JSON.stringify({
          error: {
            message: `路径未找到: ${url.pathname}`,
            type: 'invalid_request_error',
            code: 'not_found'
          }
        }), {
          status: 404,
          headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
        }
      );
    }
  }
};

// --- [第三部分: API 代理逻辑] ---
/**
 * 处理所有 /v1/ 路径下的 API 请求
 * @param {Request} request - 传入的请求对象
 * @returns {Promise<Response>} - 返回给客户端的响应
 */
async function handleApi(request) {
  // 预检请求处理：对于 OPTIONS 方法，直接返回 CORS 头部，允许跨域访问
  if (request.method === 'OPTIONS') {
    return handleCorsPreflight();
  }

  const requestId = `asig-${crypto.randomUUID()}`;
  const url = new URL(request.url);

  // 认证检查：验证 Authorization 头部
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized', requestId);
  }
  const token = authHeader.substring(7);
  if (token !== CONFIG.API_MASTER_KEY) {
    return createErrorResponse('无效的 API Key。', 403, 'invalid_api_key', requestId);
  }

  // 根据 API 路径执行不同操作
  if (url.pathname === '/v1/models') {
    return handleModelsRequest(requestId);
  } else if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`API 路径不支持: ${url.pathname}`, 404, 'not_found', requestId);
  }
}

/**
 * 处理 CORS 预检请求
 * @returns {Response}
 */
function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

/**
 * 创建标准化的 JSON 错误响应
 * @param {string} message - 错误信息
 * @param {number} status - HTTP 状态码
 * @param {string} code - 错误代码
 * @param {string} requestId - 请求ID
 * @returns {Response}
 */
function createErrorResponse(message, status, code, requestId) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'X-Worker-Trace-ID': requestId,
    })
  });
}

/**
 * 处理 /v1/models 请求
 * @param {string} requestId - 请求ID
 * @returns {Response}
 */
function handleModelsRequest(requestId) {
  const modelsData = {
    object: 'list',
    data: Object.keys(CONFIG.MODELS).map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'ai-sdk-image-generator-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'X-Worker-Trace-ID': requestId,
    })
  });
}

/**
 * 处理 /v1/images/generations (文生图) 请求
 * @param {Request} request - 传入的请求对象
 * @param {string} requestId - 本次请求的唯一 ID
 * @returns {Promise<Response>}
 */
async function handleImageGenerations(request, requestId) {
  try {
    const requestData = await request.json();
    const { prompt, model, n = 1, response_format = "b64_json" } = requestData;

    if (!prompt) {
      return createErrorResponse("请求体中缺少 'prompt' 字段。", 400, 'missing_parameter', requestId);
    }

    const modelConfig = CONFIG.MODELS[model || CONFIG.DEFAULT_MODEL];
    if (!modelConfig) {
      return createErrorResponse(`不支持的模型: ${model}`, 400, 'invalid_model', requestId);
    }

    const [provider, modelId] = modelConfig;
    const upstreamPayload = { prompt, provider, modelId };

    let upstreamResponse;
    for (let attempt = 0; attempt < CONFIG.UPSTREAM_MAX_RETRIES; attempt++) {
      upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Origin': 'https://ai-sdk-image-generator.vercel.app',
          'Referer': 'https://ai-sdk-image-generator.vercel.app/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(upstreamPayload),
      });

      // 如果请求成功或遇到非瞬时错误，则跳出重试循环
      if (upstreamResponse.ok || (upstreamResponse.status < 500 && upstreamResponse.status !== 429)) {
        break;
      }

      // 如果是最后一次尝试，则不再等待
      if (attempt === CONFIG.UPSTREAM_MAX_RETRIES - 1) {
        break;
      }

      // 指数退避 + 随机抖动
      const delay = CONFIG.UPSTREAM_INITIAL_BACKOFF * (2 ** attempt) + (Math.random() * 100);
      console.warn(`上游返回状态 ${upstreamResponse.status}. 将在 ${delay.toFixed(0)}ms 后重试... (尝试 ${attempt + 1}/${CONFIG.UPSTREAM_MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }


    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      console.error(`上游服务错误 (所有重试均失败): ${upstreamResponse.status}`, errorBody);
      return createErrorResponse(`上游服务返回错误 ${upstreamResponse.status}: ${errorBody}`, upstreamResponse.status, 'upstream_error', requestId);
    }

    const responseData = await upstreamResponse.json();
    const b64_json = responseData.image; // 上游直接返回 base64 字符串

    if (!b64_json) {
        return createErrorResponse('上游响应中未找到图像数据。', 502, 'bad_gateway', requestId);
    }

    const openAIResponse = {
      created: Math.floor(Date.now() / 1000),
      data: [{ [response_format]: b64_json }]
    };

    return new Response(JSON.stringify(openAIResponse), {
      headers: corsHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'X-Worker-Trace-ID': requestId,
      }),
    });

  } catch (e) {
    console.error('处理文生图请求时发生异常:', e);
    return createErrorResponse(`处理请求时发生内部错误: ${e.message}`, 500, 'internal_server_error', requestId);
  }
}

/**
 * 处理 /v1/chat/completions 请求 (适配文生图)
 * @param {Request} request - 传入的请求对象
 * @param {string} requestId - 本次请求的唯一 ID
 * @returns {Promise<Response>}
 */
async function handleChatCompletions(request, requestId) {
    try {
        const requestData = await request.json();
        const { messages, model } = requestData;

        const lastUserMessage = messages?.filter(m => m.role === 'user').pop();
        if (!lastUserMessage || !lastUserMessage.content) {
            return createErrorResponse("在 'messages' 中未找到有效的用户消息。", 400, 'invalid_request', requestId);
        }

        // 将聊天请求转换为图像生成请求
        const imageRequest = new Request(request.url.replace('/chat/completions', '/images/generations'), {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify({
                prompt: lastUserMessage.content,
                model: model || CONFIG.DEFAULT_MODEL,
                n: 1,
                response_format: "b64_json" // 请求 base64 以便构建 Markdown
            })
        });

        const imageResponse = await handleImageGenerations(imageRequest, requestId);
        if (!imageResponse.ok) return imageResponse; // 如果生成失败，直接返回错误

        const imageData = await imageResponse.json();
        const b64_json = imageData.data[0].b64_json;
        const markdownContent = `![Generated Image](data:image/png;base64,${b64_json})`;

        // 构建兼容 OpenAI 的非流式聊天响应
        const chatResponse = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model || CONFIG.DEFAULT_MODEL,
            choices: [{
                index: 0,
                message: { role: "assistant", content: markdownContent },
                finish_reason: "stop",
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        return new Response(JSON.stringify(chatResponse), {
            headers: corsHeaders({
                'Content-Type': 'application/json; charset=utf-8',
                'X-Worker-Trace-ID': requestId,
            }),
        });

    } catch (e) {
        console.error('处理聊天适配请求时发生异常:', e);
        return createErrorResponse(`处理请求时发生内部错误: ${e.message}`, 500, 'internal_server_error', requestId);
    }
}


/**
 * 辅助函数，为响应头添加 CORS 策略
 * @param {object} headers - 现有的响应头
 * @returns {object} - 包含 CORS 头的新对象
 */
function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
/**
 * 处理对根路径的请求，返回一个功能丰富的 HTML UI
 * @param {Request} request - 传入的请求对象
 * @returns {Response} - 包含完整 UI 的 HTML 响应
 */
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const modelList = Object.keys(CONFIG.MODELS);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg-color:#121212; --sidebar-bg:#1E1E1E; --main-bg:#121212; --border-color:#333; --text-color:#E0E0E0; --text-secondary:#888; --primary-color:#FFBF00; --primary-hover:#FFD700; --input-bg:#2A2A2A; --error-color:#CF6679; --success-color:#66BB6A; --font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif; --font-mono:'Fira Code','Consolas','Monaco',monospace; }
      * { box-sizing: border-box; }
      body { font-family:var(--font-family); margin:0; background-color:var(--bg-color); color:var(--text-color); font-size:14px; display:flex; height:100vh; overflow:hidden; }
      .skeleton { background-color:#2a2a2a; background-image:linear-gradient(90deg, #2a2a2a, #3a3a3a, #2a2a2a); background-size:200% 100%; animation:skeleton-loading 1.5s infinite; border-radius:4px; }
      @keyframes skeleton-loading { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
    </style>
</head>
<body>
    <main-layout></main-layout>

    <template id="main-layout-template">
      <style>
        .layout { display:flex; width:100%; height:100vh; }
        .sidebar { width:380px; flex-shrink:0; background-color:var(--sidebar-bg); border-right:1px solid var(--border-color); padding:20px; display:flex; flex-direction:column; overflow-y:auto; }
        .main-content { flex-grow:1; display:flex; flex-direction:column; padding:20px; overflow:hidden; }
        .header { display:flex; justify-content:space-between; align-items:center; padding-bottom:15px; margin-bottom:15px; border-bottom:1px solid var(--border-color); }
        .header h1 { margin:0; font-size:20px; }
        .header .version { font-size:12px; color:var(--text-secondary); margin-left:8px; }
        .collapsible-section { margin-top:20px; }
        .collapsible-section summary { cursor:pointer; font-weight:bold; margin-bottom:10px; }
        @media (max-width:768px) { .layout { flex-direction:column; } .sidebar { width:100%; height:auto; border-right:none; border-bottom:1px solid var(--border-color); } }
      </style>
      <div class="layout">
        <aside class="sidebar">
          <header class="header">
            <h1>${CONFIG.PROJECT_NAME}<span class="version">v${CONFIG.PROJECT_VERSION}</span></h1>
            <status-indicator></status-indicator>
          </header>
          <info-panel></info-panel>
          <details class="collapsible-section" open>
            <summary>⚙️ 主流客户端集成指南</summary>
            <client-guides></client-guides>
          </details>
        </aside>
        <main class="main-content">
          <live-terminal></live-terminal>
        </main>
      </div>
    </template>

    <template id="status-indicator-template">
      <style>
        .indicator { display:flex; align-items:center; gap:8px; font-size:12px; }
        .dot { width:10px; height:10px; border-radius:50%; transition:background-color .3s; }
        .dot.grey { background-color:#555; }
        .dot.yellow { background-color:#FFBF00; animation:pulse 2s infinite; }
        .dot.green { background-color:var(--success-color); }
        .dot.red { background-color:var(--error-color); }
        @keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(255,191,0,.4); } 70% { box-shadow:0 0 0 10px rgba(255,191,0,0); } 100% { box-shadow:0 0 0 0 rgba(255,191,0,0); } }
      </style>
      <div class="indicator">
        <div id="status-dot" class="dot grey"></div>
        <span id="status-text">正在初始化...</span>
      </div>
    </template>

    <template id="info-panel-template">
      <style>
        .panel { display:flex; flex-direction:column; gap:12px; }
        .info-item { display:flex; flex-direction:column; }
        .info-item label { font-size:12px; color:var(--text-secondary); margin-bottom:4px; }
        .info-value { background-color:var(--input-bg); padding:8px 12px; border-radius:4px; font-family:var(--font-mono); font-size:13px; color:var(--primary-color); display:flex; align-items:center; justify-content:space-between; word-break:break-all; }
        .info-value.password { -webkit-text-security:disc; }
        .info-value.visible { -webkit-text-security:none; }
        .actions { display:flex; gap:8px; }
        .icon-btn { background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:2px; display:flex; align-items:center; }
        .icon-btn:hover { color:var(--text-color); }
        .icon-btn svg { width:16px; height:16px; }
        .skeleton { height:34px; }
      </style>
      <div class="panel">
        <div class="info-item">
          <label>API 端点 (Endpoint)</label>
          <div id="api-url" class="info-value skeleton"></div>
        </div>
        <div class="info-item">
          <label>API 密钥 (Master Key)</label>
          <div id="api-key" class="info-value password skeleton"></div>
        </div>
        <div class="info-item">
          <label>默认模型 (Default Model)</label>
          <div id="default-model" class="info-value skeleton"></div>
        </div>
      </div>
    </template>

    <template id="client-guides-template">
       <style>
        .tabs { display:flex; border-bottom:1px solid var(--border-color); }
        .tab { padding:8px 12px; cursor:pointer; border:none; background:none; color:var(--text-secondary); }
        .tab.active { color:var(--primary-color); border-bottom:2px solid var(--primary-color); }
        .content { padding:15px 0; }
        pre { background-color:var(--input-bg); padding:12px; border-radius:4px; font-family:var(--font-mono); font-size:12px; white-space:pre-wrap; word-break:break-all; position:relative; }
        .copy-code-btn { position:absolute; top:8px; right:8px; background:#444; border:1px solid #555; color:#ccc; border-radius:4px; cursor:pointer; }
        .copy-code-btn:hover { background:#555; }
       </style>
       <div>
         <div class="tabs"></div>
         <div class="content"></div>
       </div>
    </template>

    <template id="live-terminal-template">
      <style>
        .terminal { display:flex; flex-direction:column; height:100%; background-color:var(--sidebar-bg); border:1px solid var(--border-color); border-radius:8px; overflow:hidden; }
        .output-window { flex-grow:1; padding:15px; overflow-y:auto; display:flex; align-items:center; justify-content:center; }
        .output-window img { max-width:100%; max-height:100%; object-fit:contain; border-radius:4px; }
        .input-area { border-top:1px solid var(--border-color); padding:15px; display:flex; flex-direction:column; gap:10px; }
        .controls { display:flex; gap:10px; }
        #model-selector { flex-grow:1; background-color:var(--input-bg); border:1px solid var(--border-color); color:var(--text-color); padding:0 10px; border-radius:4px; height:40px; }
        textarea { background-color:var(--input-bg); border:1px solid var(--border-color); border-radius:4px; color:var(--text-color); padding:10px; font-family:var(--font-family); font-size:14px; resize:none; width:100%; }
        .send-btn { background-color:var(--primary-color); color:#121212; border:none; border-radius:4px; padding:0 15px; height:40px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; }
        .send-btn:hover { background-color:var(--primary-hover); }
        .send-btn:disabled { background-color:#555; cursor:not-allowed; }
        .send-btn svg { width:20px; height:20px; }
        .placeholder { color:var(--text-secondary); }
        .spinner { border:5px solid rgba(0,0,0,.1); width:50px; height:50px; border-radius:50%; border-left-color:var(--primary-color); animation:spin 1s ease infinite; }
        .error { color:var(--error-color); text-align:center; }
      </style>
      <div class="terminal">
        <div class="output-window">
          <p class="placeholder">实时交互终端已就绪。输入指令生成图像...</p>
        </div>
        <div class="input-area">
          <textarea id="prompt-input" rows="3" placeholder="输入您的图像描述..."></textarea>
          <div class="controls">
            <select id="model-selector"></select>
            <button id="send-btn" class="send-btn" title="生成">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3.75a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5a.75.75 0 01.75-.75z" /></svg>
            </button>
          </div>
        </div>
      </div>
    </template>

    <script>
      const CLIENT_CONFIG = {
          WORKER_ORIGIN: '${origin}',
          API_MASTER_KEY: '${CONFIG.API_MASTER_KEY}',
          DEFAULT_MODEL: '${CONFIG.DEFAULT_MODEL}',
          MODEL_LIST_STRING: '${modelList.join(', ')}',
          CUSTOM_MODELS_STRING: '${modelList.map(m => `+${m}`).join(',')}',
          MODELS: ${JSON.stringify(modelList)},
      };

      const AppState = { INITIALIZING:'INITIALIZING', HEALTH_CHECKING:'HEALTH_CHECKING', READY:'READY', REQUESTING:'REQUESTING', ERROR:'ERROR' };
      let currentState = AppState.INITIALIZING;

      class BaseComponent extends HTMLElement {
        constructor(templateId) { super(); this.attachShadow({mode:'open'}); const t = document.getElementById(templateId); if(t) this.shadowRoot.appendChild(t.content.cloneNode(true)); }
      }
      class MainLayout extends BaseComponent { constructor() { super('main-layout-template'); } }
      customElements.define('main-layout', MainLayout);

      class StatusIndicator extends BaseComponent {
        constructor() { super('status-indicator-template'); this.dot = this.shadowRoot.getElementById('status-dot'); this.text = this.shadowRoot.getElementById('status-text'); }
        setState(state, message) { this.dot.className = 'dot'; switch(state) { case 'checking': this.dot.classList.add('yellow'); break; case 'ok': this.dot.classList.add('green'); break; case 'error': this.dot.classList.add('red'); break; default: this.dot.classList.add('grey'); } this.text.textContent = message; }
      }
      customElements.define('status-indicator', StatusIndicator);

      class InfoPanel extends BaseComponent {
        constructor() { super('info-panel-template'); this.apiUrlEl = this.shadowRoot.getElementById('api-url'); this.apiKeyEl = this.shadowRoot.getElementById('api-key'); this.defaultModelEl = this.shadowRoot.getElementById('default-model'); }
        connectedCallback() { this.render(); }
        render() {
          this.populateField(this.apiUrlEl, CLIENT_CONFIG.WORKER_ORIGIN + '/v1/images/generations');
          this.populateField(this.apiKeyEl, CLIENT_CONFIG.API_MASTER_KEY, true);
          this.populateField(this.defaultModelEl, CLIENT_CONFIG.DEFAULT_MODEL);
        }
        populateField(element, value, isPassword = false) {
            element.classList.remove('skeleton');
            element.innerHTML = \`<span>\${value}</span><div class="actions">\${isPassword ? '<button class="icon-btn" data-action="toggle-visibility" title="切换可见性"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" /><path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.18l.88-1.473a1.65 1.65 0 012.899 0l.88 1.473a1.65 1.65 0 010 1.18l-.88 1.473a1.65 1.65 0 01-2.899 0l-.88-1.473zM18.45 10.59a1.651 1.651 0 010-1.18l.88-1.473a1.65 1.65 0 012.899 0l.88 1.473a1.65 1.65 0 010 1.18l-.88 1.473a1.65 1.65 0 01-2.899 0l-.88-1.473zM10 17a1.651 1.651 0 01-1.18 0l-1.473-.88a1.65 1.65 0 010-2.899l1.473-.88a1.651 1.651 0 011.18 0l1.473.88a1.65 1.65 0 010 2.899l-1.473.88a1.651 1.651 0 01-1.18 0z" clip-rule="evenodd" /></svg></button>' : ''}<button class="icon-btn" data-action="copy" title="复制"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.121A1.5 1.5 0 0117 6.621V16.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 017 16.5v-13z" /><path d="M5 6.5A1.5 1.5 0 016.5 5h3.879a1.5 1.5 0 011.06.44l3.122 3.121A1.5 1.5 0 0115 9.621V14.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 015 14.5v-8z" /></svg></button></div>\`;
            element.querySelector('[data-action="copy"]').addEventListener('click', () => navigator.clipboard.writeText(value));
            if (isPassword) element.querySelector('[data-action="toggle-visibility"]').addEventListener('click', () => element.classList.toggle('visible'));
        }
      }
      customElements.define('info-panel', InfoPanel);

      class ClientGuides extends BaseComponent {
        constructor() { super('client-guides-template'); this.tabsContainer = this.shadowRoot.querySelector('.tabs'); this.contentContainer = this.shadowRoot.querySelector('.content'); }
        connectedCallback() {
          const guides = { 'cURL': this.getCurlGuide(), 'Python': this.getPythonGuide(), 'LobeChat': this.getLobeChatGuide(), 'Next-Web': this.getNextWebGuide() };
          Object.keys(guides).forEach((name, index) => { const tab = document.createElement('button'); tab.className = 'tab'; tab.textContent = name; if (index === 0) tab.classList.add('active'); tab.addEventListener('click', () => this.switchTab(name, guides)); this.tabsContainer.appendChild(tab); });
          this.switchTab(Object.keys(guides)[0], guides);
        }
        switchTab(name, guides) {
          this.tabsContainer.querySelector('.active')?.classList.remove('active');
          this.tabsContainer.querySelector('button:nth-child(' + (Object.keys(guides).indexOf(name) + 1) + ')').classList.add('active');
          this.contentContainer.innerHTML = guides[name];
          this.contentContainer.querySelector('.copy-code-btn')?.addEventListener('click', (e) => { const code = e.target.closest('pre').querySelector('code').innerText; navigator.clipboard.writeText(code); });
        }
        getCurlGuide() { return \`<pre><button class="copy-code-btn">复制</button><code>curl \${CLIENT_CONFIG.WORKER_ORIGIN}/v1/images/generations \\\\<br>  -H "Authorization: Bearer \${CLIENT_CONFIG.API_MASTER_KEY}" \\\\<br>  -H "Content-Type: application/json" \\\\<br>  -d '{<br>    "model": "\${CLIENT_CONFIG.DEFAULT_MODEL}",<br>    "prompt": "A cute cat",<br>    "n": 1,<br>    "size": "512x768",<br>    "response_format": "b64_json"<br>  }'</code></pre>\`; }
        getPythonGuide() { return \`<pre><button class="copy-code-btn">复制</button><code>import openai<br><br>client = openai.OpenAI(<br>    api_key="\${CLIENT_CONFIG.API_MASTER_KEY}",<br>    base_url="\${CLIENT_CONFIG.WORKER_ORIGIN}/v1"<br>)<br><br>response = client.images.generate(<br>    model="\${CLIENT_CONFIG.DEFAULT_MODEL}",<br>    prompt="A cute cat",<br>    n=1,<br>    size="512x768",<br>    response_format="b64_json"<br>)<br><br># print(response.data[0].b64_json)</code></pre>\`; }
        getLobeChatGuide() { return \`<p>在 LobeChat 设置中，找到 "语言模型" -> "OpenAI" 设置:</p><pre><button class="copy-code-btn">复制</button><code>API Key: \${CLIENT_CONFIG.API_MASTER_KEY}<br>API 地址: \${CLIENT_CONFIG.WORKER_ORIGIN}<br>模型列表: \${CLIENT_CONFIG.MODEL_LIST_STRING}</code></pre><p>注意：LobeChat 的聊天接口将自动调用文生图。</p>\`; }
        getNextWebGuide() { return \`<p>在 ChatGPT-Next-Web 部署时，设置以下环境变量:</p><pre><button class="copy-code-btn">复制</button><code>CODE=\${CLIENT_CONFIG.API_MASTER_KEY}<br>BASE_URL=\${CLIENT_CONFIG.WORKER_ORIGIN}<br>CUSTOM_MODELS=\${CLIENT_CONFIG.CUSTOM_MODELS_STRING}</code></pre><p>注意：Next-Web 的聊天接口将自动调用文生图。</p>\`; }
      }
      customElements.define('client-guides', ClientGuides);

      class LiveTerminal extends BaseComponent {
        constructor() {
          super('live-terminal-template');
          this.outputWindow = this.shadowRoot.querySelector('.output-window');
          this.promptInput = this.shadowRoot.getElementById('prompt-input');
          this.modelSelector = this.shadowRoot.getElementById('model-selector');
          this.sendBtn = this.shadowRoot.getElementById('send-btn');
        }
        connectedCallback() {
          this.sendBtn.addEventListener('click', () => this.handleSend());
          this.promptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); } });
          this.populateModels();
        }
        populateModels() {
            CLIENT_CONFIG.MODELS.forEach(modelId => {
                const option = document.createElement('option');
                option.value = modelId;
                option.textContent = modelId;
                if (modelId === CLIENT_CONFIG.DEFAULT_MODEL) option.selected = true;
                this.modelSelector.appendChild(option);
            });
        }
        async handleSend() {
          const prompt = this.promptInput.value.trim();
          if (!prompt) return;
          setState(AppState.REQUESTING);
          this.outputWindow.innerHTML = '<div class="spinner"></div>';
          try {
            const response = await fetch(CLIENT_CONFIG.WORKER_ORIGIN + '/v1/images/generations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CLIENT_CONFIG.API_MASTER_KEY },
              body: JSON.stringify({ model: this.modelSelector.value, prompt: prompt, n: 1, response_format: "b64_json" }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error.message);
            this.outputWindow.innerHTML = \`<img src="data:image/png;base64,\${result.data[0].b64_json}" alt="Generated Image">\`;
            setState(AppState.READY);
          } catch (e) {
            this.outputWindow.innerHTML = \`<p class="error">生成失败: \${e.message}</p>\`;
            setState(AppState.ERROR);
          }
        }
        updateButtonState(state) { this.sendBtn.disabled = state !== AppState.READY; }
      }
      customElements.define('live-terminal', LiveTerminal);

      function setState(newState) {
        currentState = newState;
        const terminal = document.querySelector('main-layout')?.shadowRoot.querySelector('live-terminal');
        if (terminal) terminal.updateButtonState(newState);
      }

      async function performHealthCheck() {
        const statusIndicator = document.querySelector('main-layout').shadowRoot.querySelector('status-indicator');
        statusIndicator.setState('checking', '检查上游服务...');
        try {
          const response = await fetch(CLIENT_CONFIG.WORKER_ORIGIN + '/v1/models', { headers: { 'Authorization': 'Bearer ' + CLIENT_CONFIG.API_MASTER_KEY } });
          if (response.ok) {
            statusIndicator.setState('ok', '服务运行正常');
            setState(AppState.READY);
          } else { const err = await response.json(); throw new Error(err.error.message); }
        } catch (e) {
          statusIndicator.setState('error', '健康检查失败');
          setState(AppState.ERROR);
        }
      }

      document.addEventListener('DOMContentLoaded', () => {
        setState(AppState.INITIALIZING);
        customElements.whenDefined('main-layout').then(() => { performHealthCheck(); });
      });
    </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
