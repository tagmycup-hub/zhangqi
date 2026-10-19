// @ts-nocheck
// 账期助手识别服务 · Supabase Edge Function（由 npm run build:worker 生成，请勿手改）
// 需要的 Secret：GEMINI_API_KEY（或 ANTHROPIC_API_KEY）。函数设置里关闭 Verify JWT。

// shared/recognize-prompt.txt
var recognize_prompt_default = '你是一名严谨的票据录入员。图片是巴西一家小公司收到的一张单据，可能是以下任意一种：\n- order：商家的手写或打印订单（Pedido、收据，可能含中文、葡萄牙语、数字和字母型号，蓝色表格线、阴影、透视变形）\n- boleto：银行付款单（Boleto / Ficha de Compensação，有银行代码、47 位数字线、条码、Vencimento、Valor do Documento）\n- utility：水、电、燃气、网络、电话账单（如 Sabesp、Enel、Comgás、Vivo），通常有"Total a pagar""Vencimento"、二维码或 48 位数字线\n- tax：税费或政府缴费单（DAS、DARF、GPS、FGTS Digital/GFD、IPTU 等）\n- payslip：工资单（Recibo de Pagamento de Salário）\n- statement：对账单 / 欠款明细表（一张表里有多笔订单和付款记录，例如供应商发来的 Excel 截图）\n- receipt：其他收据或单据\n\n判断 docType：印有 47/48 位数字线或条码 → boleto / utility / tax（按收款方判断）；表格里有多笔订单号和付款记录 → statement；有逐行「数量、型号、单价」→ order；只有一个金额的收条 → receipt。\n\n任务：逐字读取单据，只输出一个符合下列 Schema 的 JSON 对象，不要输出任何其他文字。\n\n{\n  "docType": "order"|"boleto"|"utility"|"tax"|"payslip"|"statement"|"receipt",\n  "merchant": {"value": string|null, "confidence": 0..1, "candidates": [string]},\n  "orderNumber": {"value": string|null, "confidence": 0..1},\n  "billDate": {"raw": string|null, "iso": "YYYY-MM-DD"|null, "confidence": 0..1},\n  "dueDate": {"raw": string|null, "iso": "YYYY-MM-DD"|null, "confidence": 0..1},\n  "amountDue": {"raw": string|null, "cents": integer|null, "confidence": 0..1},\n  "paymentLine": string|null,\n  "pixCode": string|null,\n  "referenceMonth": string|null,\n  "categoryHint": "water"|"electricity"|"gas"|"internet"|"phone"|"rent"|"condo"|"tax"|"payroll"|"accounting"|"logistics"|"platform"|"loan"|"subscription"|"other"|null,\n  "items": [\n    {"row": 1, "quantity": number|null, "boxes": number|null, "perBox": number|null,\n     "description": string|null,\n     "unitPriceRaw": string|null, "unitPriceCents": integer|null,\n     "printedSubtotalRaw": string|null, "printedSubtotalCents": integer|null,\n     "confidence": 0..1, "needsReview": boolean,\n     "bbox": [x, y, w, h] | null}\n  ],\n  "printedTotalRaw": string|null,\n  "printedTotalCents": integer|null,\n  "statement": {\n    "entries": [{"date": "YYYY-MM-DD"|null, "dateRaw": string|null, "orderNumber": string|null, "cents": integer|null, "raw": string|null, "paid": boolean|null}],\n    "payments": [{"date": "YYYY-MM-DD"|null, "cents": integer|null, "note": string|null}],\n    "balanceCents": integer|null\n  } | null,\n  "unparsedLines": [string],\n  "warnings": [string]\n}\n\n字段说明：\n- merchant：收款方。订单写商家名；boleto 写 Beneficiário（受益人/收款公司）；水电账单写公司名（如 "Enel"）；税费写税种（如 "FGTS"、"DAS"）；工资单写员工姓名；对账单写对方名称或表头上的客户编号（如 "KH-3913"）。不要写付款人（Pagador / 本公司）。\n- dueDate：Vencimento / "Pagar até"。工资单没有到期日时为 null。\n- amountDue：本单应付金额。boleto 取 "Valor do Documento"；水电取 "Total a pagar"；税费取 "Valor a recolher / Total"；工资单取 "Líquido a receber"；订单取总额。\n- paymentLine：如果单据上印有数字线（linha digitável，47 或 48 位，常见格式如 "34191.09008 04545.379275 90742.810006 9 16010000314822"），逐位照抄；没有或看不清就 null。绝不编造或补全任何一位。\n- pixCode：如果印有 "PIX Copia e Cola" 文字，原样照抄；二维码图片本身不要尝试解码，填 null。\n- referenceMonth：账单所属月份原文（如 "SET/2026"、"Setembro/2026"、"OUTUBRO 2026"）。\n- items：订单逐行明细；boleto / 水电单上的分项（如 "ALUGUEL 1.700,00"、"CONDOMINIO 1.448,22"）每项一行，quantity 填 1，金额写进 unitPrice 和 printedSubtotal。工资单、只有一个总额的单据 items 可为空数组。\n- 手写订单常见写法「箱数 × 每箱件数 × 单价 = 小计」（例如 "2 × 50 × 19 = 1900"）：boxes 填 2、perBox 填 50、quantity 填总件数 100、unitPrice 填 19。只有「数量 × 单价」时 boxes、perBox 为 null。\n- statement：只有 docType 为 statement 时填写。每笔订单/欠款一条 entry；paid 根据表格里的已付标记（颜色、对勾、对应付款）判断，看不出来就 null；payments 是付款记录表里的每一行；balanceCents 是"结欠/Saldo devedor"。其他类型填 null。\n\n硬性规则：\n1. 逐字读取并保留原文。*Raw 字段照抄图片上的写法（例如 "8"、"15,00"、"1.234,56"）。\n2. 看不清就返回 null，并把 needsReview 设为 true，confidence 如实降低。绝不猜测。\n3. 型号/描述按图片原样保留大小写、连字符、空格、中文和数字（如 "FN-A78"、"CA31-3"、"800ml 黑"），不得根据常识补全或"纠正"。\n4. 金额是巴西雷亚尔：逗号是小数点，点是千位分隔（Excel 截图里若明显用点做小数点、逗号做千位，如 "2,808.00"，按截图的写法换算并在 warnings 说明）。*Cents 为整数分（"8" → 800，"1.234,56" → 123456）。无法确定格式时 *Cents 返回 null 并在 warnings 说明。\n5. 不得为了让小计或总额相等而修改任何识别到的数字；算术不一致、总额被涂改或有两个不同的总额时照实输出，并在 warnings 里说明。\n6. 订单号、单号保留前导零，作为字符串输出。\n7. 日期：raw 照抄；只有年份写全（4 位）且日期真实存在时才填 iso，否则 iso 为 null。\n8. 任何包含数字但你无法可靠拆成明细的行，原样放入 unparsedLines，不要丢弃。\n9. bbox 是该明细行在图片中的归一化位置（0–1，左上为原点）；无法确定则为 null。\n10. 只描述这张图片里真实存在的内容；表头、签名、旁边纸张上的内容不要当作明细。\n\n手写订单读法要点：\nA. 先通读整张单据，弄清每列含义（数量 / 箱数×每箱 / 型号 / 单价 / 小计）和每一行的对应关系，再逐行读；一行写不下折到下一行的，合并成一行。\nB. 手写数字常见混淆：1/7、4/9、5/6、0/6、3/8、2/7、S/5、B/8、O/0、I/1、Z/2。一个字形本身有两种合理读法时，可以用同一行「数量×单价=小计」的关系选择读法，但该行 confidence 不得高于 0.8，并在 warnings 写明「第 N 行按小计辨认 X」；清楚可读的数字绝不能为了凑数而改。\nC. 「〃」「"」「同上」「do」表示与上一行相同：展开写成上一行的完整内容，并在 warnings 注明。\nD. 被划掉的行或数字不要读；同一位置改写过的，读最后写上的那个。\nE. 中文数字（一、二、两、十、廿、百）换成阿拉伯数字；「件、个、pç、pc、un」是件数，「箱、cx、caixa」是箱数（填 boxes）；「打、dz、dúzia」照单据写的数量填写，description 末尾保留「(dz)」，不要自行换算。\nF. 型号里的字母 O 与数字 0、字母 I 与数字 1：按同一张单据其他行同系列型号的写法统一（例如其他行都是 "FN-A78"，就不要读成 "FN-A7B"）。\nG. 底部总额常写成 Total / TOTAL / 合计 / 总计 / 共；有分页小计和总计时取最后的总计，并在 warnings 说明。\nH. 商家名通常在抬头、印章或名片位置；手写单据上没有商家名时 merchant 为 null，不要从别处推断。\nI. confidence 要有区分度：每个字都清楚 ≥ 0.95；有一个字符拿不准 0.6–0.8；多处拿不准 ≤ 0.5。needsReview 只在确有拿不准的字符时为 true。\n';

// shared/hints.mjs
var HINTS_MAX = 6e3;
function withHints(prompt, hints) {
  const h = String(hints ?? "").trim().slice(0, HINTS_MAX);
  if (!h) return prompt;
  return prompt + "\n\n【参考资料】以下是这位用户以往记录的商家与型号，只用来帮助辨认模糊的手写字：图片上没有的内容绝不能因为参考资料而写出；看得清的字以图片为准；某处字形本身模糊、而按常用型号/商家名读正好说得通时，可以这样读，但该字段 confidence 不得高于 0.8，并在 warnings 写明「按常用型号辨认」。\n" + h;
}

// server/core.mjs
var MEDIA_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp"]);
function extractJson(text) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return void 0;
    }
  };
  let v = tryParse(text.trim());
  if (v !== void 0) return v;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && (v = tryParse(fence[1])) !== void 0) return v;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a && (v = tryParse(text.slice(a, b + 1))) !== void 0) return v;
  return void 0;
}
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function createHandler({ prompt, log: log2 = () => {
}, authorize = null, health = null }) {
  const hits = /* @__PURE__ */ new Map();
  const cfg = (env) => {
    const gKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
    const aKey = env.ANTHROPIC_API_KEY || "";
    const want = String(env.AI_PROVIDER || "").toLowerCase();
    const provider = want === "anthropic" && aKey ? "anthropic" : want === "gemini" && gKey ? "gemini" : gKey ? "gemini" : aKey ? "anthropic" : null;
    return {
      provider,
      apiKey: provider === "gemini" ? gKey : aKey,
      model: provider === "gemini" ? env.GEMINI_MODEL || "gemini-3.8-flash" : env.ANTHROPIC_MODEL || "claude-sonnet-5",
      apiUrl: provider === "gemini" ? env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta" : env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages",
      thinking: env.GEMINI_THINKING === "off" ? "" : env.GEMINI_THINKING || "low",
      fallbacks: String(env.GEMINI_FALLBACK_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean),
      /** 整个识别请求的时间预算（Supabase 函数最长约 150 秒） */
      budget: Number(env.RECOGNIZE_BUDGET_MS || 12e4),
      origins: String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
      tokens: String(env.ACCESS_TOKEN || "").split(",").map((s) => s.trim()).filter(Boolean),
      maxBytes: Number(env.MAX_IMAGE_BYTES || 6 * 1024 * 1024),
      timeout: Number(env.RECOGNIZE_TIMEOUT_MS || 9e4),
      rate: Number(env.RATE_PER_MIN || 10)
    };
  };
  const KEY_ENV = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
  function rateLimited(key, limit) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < 6e4);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5e3) hits.clear();
    return arr.length > limit;
  }
  function corsHeaders(request, c) {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (c.origins.includes("*") || c.origins.includes(origin)) {
      return {
        "access-control-allow-origin": origin,
        vary: "Origin",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-access-token,apikey,authorization,x-client-info",
        "access-control-max-age": "86400"
      };
    }
    return {};
  }
  const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
  async function post(c, url, headers, body, timeout = c.timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      return await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      if (e && e.name === "AbortError") throw new HttpError(504, "识别超时，请重试或裁小图片");
      throw new HttpError(502, "连接视觉模型失败");
    } finally {
      clearTimeout(timer);
    }
  }
  function upstreamMessage(detail) {
    try {
      const j = JSON.parse(detail);
      const m = j?.error?.message || j?.message || "";
      return String(m).replace(/\s+/g, " ").slice(0, 160);
    } catch {
      return "";
    }
  }
  function upstreamError(c, status, detail = "", model = c.model) {
    const msg = upstreamMessage(detail);
    log2(`[recognize] upstream ${c.provider} ${model} HTTP ${status}${msg ? " · " + msg : ""}`);
    const keyName = KEY_ENV[c.provider];
    if (status === 503 || status === 529 || status === 500) return new HttpError(503, `模型「${model}」暂时繁忙（${status}），已自动重试，请过一会儿再点「重试」`);
    if (status === 401 || status === 403 || status === 400 && /API key|API_KEY/i.test(detail)) return new HttpError(502, `模型密钥无效或没有权限，请检查服务器上的 ${keyName}`);
    if (status === 429) return new HttpError(429, "模型服务繁忙或今日免费额度已用完，请稍后再试");
    if (status === 404) return new HttpError(502, `模型「${model}」不可用，请检查 ${c.provider === "gemini" ? "GEMINI_MODEL" : "ANTHROPIC_MODEL"}`);
    if (status === 400 && /location|region|not supported/i.test(detail)) return new HttpError(502, "模型服务在当前地区不可用");
    return new HttpError(502, `模型服务出错（${status}）${msg ? "：" + msg : ""}`);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRYABLE = /* @__PURE__ */ new Set([500, 502, 503, 504, 529]);
  async function callAnthropic(c, mediaType, imageBase64, fullPrompt = prompt) {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await post(c, c.apiUrl, { "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" }, {
        model: c.model,
        max_tokens: 6e3,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
              { type: "text", text: fullPrompt }
            ]
          }
        ]
      });
      if (r.ok || !RETRYABLE.has(r.status) || attempt === 2) break;
      await sleep(1500 * (attempt + 1));
    }
    if (!r.ok) throw upstreamError(c, r.status, await r.text().catch(() => ""));
    const data = await r.json();
    return (data.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
  }
  let modelCache = null;
  async function discoverModels(c) {
    if (modelCache && modelCache.key === c.apiKey && Date.now() - modelCache.at < 36e5) return modelCache.list;
    let list = [];
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6e3);
      const r = await fetch(`${c.apiUrl.replace(/\/$/, "")}/models?pageSize=200`, { headers: { "x-goog-api-key": c.apiKey }, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
        list = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name || "").replace(/^models\//, "")).filter((n) => /^gemini-/.test(n) && /flash/.test(n) && !/image|tts|audio|live|native|embed|computer|robotics/.test(n)).sort((a, b) => Number(/lite/.test(a)) - Number(/lite/.test(b)) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || ver(b) - ver(a));
        log2(`[recognize] available flash models: ${list.slice(0, 8).join(", ") || "(none)"}`);
      } else log2(`[recognize] list models HTTP ${r.status}`);
    } catch {
      log2("[recognize] list models failed");
    }
    modelCache = { key: c.apiKey, at: Date.now(), list };
    return list;
  }
  async function callGemini(c, mediaType, imageBase64, fullPrompt = prompt) {
    const started = Date.now();
    const queue = [c.model, ...c.fallbacks.filter((m) => m !== c.model)];
    let discovered = false;
    let thinking = c.thinking;
    const errors = [];
    for (let i = 0; i < queue.length && i < 4; i++) {
      const model = queue[i];
      let modelErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = c.budget - (Date.now() - started);
        if (left < 8e3) {
          modelErr = modelErr || new HttpError(504, "识别超时，请重试或裁小图片");
          i = queue.length;
          break;
        }
        const generationConfig = { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 16384 };
        if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
        const url = `${c.apiUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
        let r;
        try {
          r = await post(c, url, { "x-goog-api-key": c.apiKey }, {
            contents: [{ role: "user", parts: [{ inline_data: { mime_type: mediaType, data: imageBase64 } }, { text: fullPrompt }] }],
            generationConfig
          }, Math.min(c.timeout, left));
        } catch (e) {
          modelErr = e;
          if (e instanceof HttpError && e.status === 504) break;
          continue;
        }
        if (r.ok) {
          const data = await r.json();
          if (data.promptFeedback?.blockReason) throw new HttpError(422, "图片被模型安全策略拦截，请换一张或手工录入");
          const cand = (data.candidates || [])[0];
          const text = (cand?.content?.parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
          if (text) {
            if (model !== c.model) log2(`[recognize] used fallback model ${model}`);
            return text;
          }
          if (cand?.finishReason === "MAX_TOKENS") throw new HttpError(502, "识别结果太长被截断，请把单据裁成两部分分别识别");
          modelErr = new HttpError(502, "模型没有返回识别结果，请重试");
          continue;
        }
        const detail = await r.text().catch(() => "");
        if (r.status === 400 && thinking && /thinking/i.test(detail)) {
          thinking = "";
          attempt--;
          continue;
        }
        modelErr = upstreamError(c, r.status, detail, model);
        modelErr.notFound = r.status === 404;
        if (r.status === 404) break;
        if (r.status === 429 && /quota|exhaust/i.test(detail)) break;
        if (!RETRYABLE.has(r.status)) throw modelErr;
        await sleep(1200 * (attempt + 1));
      }
      if (modelErr) errors.push(modelErr);
      if (i === queue.length - 1 && !discovered) {
        discovered = true;
        for (const m of await discoverModels(c)) if (!queue.includes(m)) queue.push(m);
      }
    }
    throw errors.find((e) => !e.notFound) || errors[0] || new HttpError(502, "模型服务出错");
  }
  async function recognize(request, c) {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > c.maxBytes * 1.4 + 2048) throw new HttpError(413, "图片过大");
    const body = await request.text();
    if (body.length > c.maxBytes * 1.4 + 2048) throw new HttpError(413, "图片过大");
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new HttpError(400, "请求不是 JSON");
    }
    const { mediaType, imageBase64, hints } = payload || {};
    if (hints != null && typeof hints !== "string") throw new HttpError(400, "参考资料格式错误");
    const fullPrompt = withHints(prompt, hints);
    if (!MEDIA_TYPES.has(mediaType)) throw new HttpError(415, "只接受 JPG、PNG、WebP 图片");
    if (typeof imageBase64 !== "string" || !imageBase64 || !/^[A-Za-z0-9+/=]+$/.test(imageBase64)) throw new HttpError(400, "图片数据无效");
    if (imageBase64.length * 3 / 4 > c.maxBytes) throw new HttpError(413, "图片过大");
    const text = c.provider === "gemini" ? await callGemini(c, mediaType, imageBase64, fullPrompt) : await callAnthropic(c, mediaType, imageBase64, fullPrompt);
    let result = extractJson(text);
    if (Array.isArray(result) && result.length === 1 && result[0] && typeof result[0] === "object") result = result[0];
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new HttpError(502, "模型没有返回符合格式的 JSON，请重试");
    if (!Array.isArray(result.items)) {
      if (result.items != null) throw new HttpError(502, "模型没有返回符合格式的 JSON，请重试");
      result.items = [];
    }
    return { result, rawText: text.slice(0, 2e4), model: c.model };
  }
  return async function handle2(request, env = {}) {
    const c = cfg(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return null;
    const cors2 = corsHeaders(request, c);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors2 });
    const given = request.headers.get("x-access-token") || request.headers.get("apikey") || "";
    const tokenOk = !c.tokens.length || c.tokens.some((t) => safeEqual(given, t));
    if (url.pathname === "/api/health") {
      const extra = health ? await health(request, env).catch(() => ({})) : {};
      return json(200, { ok: true, configured: Boolean(c.apiKey), provider: c.provider, model: c.apiKey ? c.model : null, auth: c.tokens.length > 0, tokenOk, ...extra }, cors2);
    }
    if (url.pathname === "/api/recognize") {
      if (request.method !== "POST") return json(405, { error: "只支持 POST" }, cors2);
      if (!c.apiKey) return json(503, { error: "服务器未配置模型密钥（GEMINI_API_KEY 或 ANTHROPIC_API_KEY）" }, cors2);
      const ip = request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
      let grant = null;
      if (authorize) {
        grant = await authorize(request, env);
        if (!grant.ok) return json(grant.status || 401, { error: grant.error, code: grant.code }, cors2);
      } else if (!tokenOk) {
        if (rateLimited(`bad:${ip}`, 5)) return json(429, { error: "口令错误次数过多，请稍后再试" }, cors2);
        return json(401, { error: "访问口令不正确，请在「设置 → 识别服务」里填写" }, cors2);
      }
      if (rateLimited(grant?.key || ip, c.rate)) {
        await grant?.done?.(false);
        return json(429, { error: "请求太频繁，请一分钟后再试" }, cors2);
      }
      try {
        const t0 = Date.now();
        const out = await recognize(request, c);
        log2(`[recognize] ok ${Date.now() - t0}ms items=${out.result.items.length}`);
        const usage = grant?.done ? await grant.done(true) : void 0;
        return json(200, usage ? { ...out, usage } : out, cors2);
      } catch (e) {
        await grant?.done?.(false);
        return json(e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : "服务器内部错误" }, cors2);
      }
    }
    return json(404, { error: "not found" }, cors2);
  };
}

// src/lib/dates.ts
var TZ = "America/Sao_Paulo";
function todayISO(now = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function isoToUTCms(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function diffDays(a, b) {
  return Math.round((isoToUTCms(b) - isoToUTCms(a)) / 864e5);
}
function relativeDue(dueISO, today) {
  const n = diffDays(today, dueISO);
  if (n === 0) return "今天到期";
  if (n === 1) return "明天到期";
  if (n > 1) return `${n} 天后到期`;
  return `逾期 ${-n} 天`;
}

// src/lib/money.ts
function sumCents(values) {
  let t = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error("sumCents 只接受整数分");
    t += v;
  }
  return t;
}
function formatBRL(cents, withSymbol = true) {
  if (cents === null || cents === void 0 || !Number.isFinite(cents)) return "—";
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, "0");
  const intStr = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${withSymbol ? "R$ " : ""}${intStr},${dec}`;
}

// src/lib/payments.ts
function paymentsOf(b) {
  if (b.payments?.length) return [...b.payments].sort((x, y) => x.date.localeCompare(y.date));
  if (b.paidAt) return [{ id: `${b.id}-legacy`, date: todayISO(new Date(b.paidAt)), cents: b.totalCents }];
  return [];
}
var paidCents = (b) => sumCents(paymentsOf(b).map((p) => p.cents));
var openCents = (b) => b.paidAt ? 0 : Math.max(0, b.totalCents - paidCents(b));
var isPartial = (b) => !b.paidAt && paidCents(b) > 0;

// src/lib/status.ts
function billStatus(bill, today, dueSoonDays = 7) {
  if (bill.paidAt) return "paid";
  const left = diffDays(today, bill.dueDate);
  if (left < 0) return "overdue";
  if (left <= dueSoonDays) return "dueSoon";
  return "open";
}
function inReminderWindow(bill, today) {
  if (bill.paidAt) return false;
  return diffDays(today, bill.dueDate) <= bill.reminderDays;
}

// server/webpush.mjs
var enc = new TextEncoder();
function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - s.length % 4) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64u(raw), privateJwk };
}
async function vapidAuthorization(endpoint, vapid, subject = "mailto:noreply@example.com", now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1e3) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`)));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapid.publicKey}`;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
async function encryptPayload(plaintext, p256dh, auth, opts = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("订阅密钥格式不正确");
  const as = opts.serverKeys ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}
async function sendPush(sub, payload, vapid, { subject, ttl = 86400, fetchImpl = fetch, urgency = "normal" } = {}) {
  const body = await encryptPayload(enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload)), sub.p256dh, sub.auth);
  const r = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(sub.endpoint, vapid, subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency
    },
    body
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
}

// supabase/saas.mjs
var ApiError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
var num = (v, d) => v !== void 0 && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
function saasConfig(env) {
  const get = (k) => env[k] || "";
  let secret = "";
  try {
    const j = JSON.parse(get("SUPABASE_SECRET_KEYS") || "{}");
    secret = j.default || Object.values(j)[0] || "";
  } catch {
  }
  secret = secret || get("SUPABASE_SERVICE_ROLE_KEY");
  let publishable = "";
  try {
    const j = JSON.parse(get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    publishable = j.default || Object.values(j)[0] || "";
  } catch {
  }
  publishable = publishable || get("SUPABASE_ANON_KEY");
  return {
    url: get("SUPABASE_URL").replace(/\/+$/, ""),
    secret,
    publishable,
    anon: get("SUPABASE_ANON_KEY"),
    mpToken: get("MP_ACCESS_TOKEN"),
    mpWebhookSecret: get("MP_WEBHOOK_SECRET"),
    mpApi: get("MP_API_URL") || "https://api.mercadopago.com",
    price: num(get("PRO_PRICE"), 19.9),
    freeAi: num(get("PLAN_FREE_AI"), 20),
    proAi: num(get("PLAN_PRO_AI"), 500),
    owners: get("OWNER_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowKeyOnly: /^(1|true|yes|on)$/i.test(get("ALLOW_KEY_ONLY")),
    pushSubject: get("PUSH_SUBJECT") || "mailto:noreply@zhangqi.app"
  };
}
function createSaas({ fetchImpl = (...a) => fetch(...a), log: log2 = () => {
}, now = () => /* @__PURE__ */ new Date() } = {}) {
  function dbHeaders(c, extra = {}) {
    const h = { apikey: c.secret, "content-type": "application/json", ...extra };
    if (c.secret.startsWith("eyJ")) h.authorization = `Bearer ${c.secret}`;
    return h;
  }
  async function db(c, path, init = {}) {
    if (!c.url || !c.secret) throw new ApiError(500, "函数缺少 SUPABASE_URL 或 service key");
    const r = await fetchImpl(`${c.url}/rest/v1/${path}`, { ...init, headers: dbHeaders(c, init.headers) });
    const text = await r.text();
    if (!r.ok) {
      log2(`[saas] db ${path.split("?")[0]} HTTP ${r.status} ${text.slice(0, 160)}`);
      if (/does not exist|PGRST20[25]|Could not find/i.test(text)) throw new ApiError(500, "数据库还没升级：请在 Supabase SQL Editor 重新运行最新的 setup.sql", "no_setup");
      throw new ApiError(500, `数据库错误（${r.status}）`);
    }
    return text ? JSON.parse(text) : null;
  }
  const rpc = (c, fn, args) => db(c, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  async function kvGet(c, key) {
    const rows = await db(c, `zq_kv?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows?.[0]?.value ?? null;
  }
  async function kvSet(c, key, value) {
    await db(c, "zq_kv", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: now().toISOString() }) });
  }
  const userCache = /* @__PURE__ */ new Map();
  async function getUser(c, request) {
    const h = request.headers.get("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1].trim();
    if (token === c.publishable || token === c.anon || token.startsWith("sb_")) return null;
    const hit = userCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    const r = await fetchImpl(`${c.url}/auth/v1/user`, { headers: { apikey: c.publishable || c.secret, authorization: `Bearer ${token}` } });
    if (!r.ok) throw new ApiError(401, "登录已过期，请重新登录", "session_expired");
    const u = await r.json();
    if (!u?.id) throw new ApiError(401, "登录已过期，请重新登录", "session_expired");
    const user = { id: u.id, email: String(u.email || "").toLowerCase() };
    userCache.set(token, { user, exp: Date.now() + 6e4 });
    if (userCache.size > 500) userCache.clear();
    return user;
  }
  async function requireUser(c, request) {
    const u = await getUser(c, request);
    if (!u) throw new ApiError(401, "请先登录（设置 → 账号）", "login_required");
    return u;
  }
  const monthOf = (d = now()) => todayISO(d).slice(0, 7);
  async function getProfile(c, user) {
    const rows = await db(c, `zq_profiles?user_id=eq.${user.id}&select=*`);
    if (rows?.[0]) return rows[0];
    const p = { user_id: user.id, email: user.email, plan: "free" };
    await db(c, "zq_profiles", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(p) });
    return { ...p, plan_until: null, mp_preapproval_id: null, mp_status: null };
  }
  function effectivePlan(c, user, profile) {
    if (c.owners.includes(user.email)) return "owner";
    if (profile?.plan_until && Date.parse(profile.plan_until) > now().getTime()) return "pro";
    return "free";
  }
  const limitOf = (c, plan) => plan === "owner" ? -1 : plan === "pro" ? c.proAi : c.freeAi;
  async function usageOf(c, user) {
    const rows = await db(c, `zq_usage?user_id=eq.${user.id}&month=eq.${monthOf()}&select=ai`);
    return rows?.[0]?.ai ?? 0;
  }
  async function authorizeRecognize(request, env) {
    const c = saasConfig(env);
    let user;
    try {
      user = await getUser(c, request);
    } catch (e) {
      return { ok: false, status: e.status || 401, error: e.message, code: e.code };
    }
    if (!user) {
      if (c.allowKeyOnly) {
        const given = request.headers.get("apikey") || request.headers.get("x-access-token") || "";
        const keys = [c.publishable, env.SUPABASE_ANON_KEY, ...String(env.ACCESS_TOKEN || "").split(",")].filter(Boolean);
        return keys.includes(given) ? { ok: true } : { ok: false, status: 401, error: "访问口令不正确" };
      }
      return { ok: false, status: 401, error: "AI 识别需要登录：设置 → 账号，用邮箱验证码登录", code: "login_required" };
    }
    try {
      const profile = await getProfile(c, user);
      const plan = effectivePlan(c, user, profile);
      const limit = limitOf(c, plan);
      const month = monthOf();
      const n = await rpc(c, "zq_usage_take", { p_user: user.id, p_month: month, p_limit: limit });
      if (n === -1 || n === null) {
        return {
          ok: false,
          status: 402,
          code: "quota",
          error: plan === "pro" ? `本月 ${limit} 张 AI 识别已用完，下月 1 日恢复` : `免费版本月 ${limit} 张 AI 识别已用完${c.mpToken ? "，升级专业版即可继续" : ""}`
        };
      }
      return {
        ok: true,
        key: `u:${user.id}`,
        done: async (success) => {
          if (!success) {
            await rpc(c, "zq_usage_refund", { p_user: user.id, p_month: month }).catch(() => {
            });
            return void 0;
          }
          return { used: n, limit, plan };
        }
      };
    } catch (e) {
      return { ok: false, status: e.status || 500, error: e.message, code: e.code };
    }
  }
  async function me(c, request) {
    const user = await requireUser(c, request);
    const profile = await getProfile(c, user);
    let p = profile;
    if (c.mpToken && p.mp_preapproval_id && p.mp_status !== "authorized" && p.mp_status !== "cancelled") {
      p = await refreshPreapproval(c, p.mp_preapproval_id).catch(() => null) ?? p;
    }
    const plan = effectivePlan(c, user, p);
    await rememberFnUrl(c, request).catch(() => {
    });
    return {
      email: user.email,
      plan,
      planUntil: p.plan_until ?? null,
      subscription: p.mp_preapproval_id ? { status: p.mp_status ?? null } : null,
      usage: { month: monthOf(), ai: await usageOf(c, user), limit: limitOf(c, plan) },
      billing: c.mpToken ? { price: c.price, currency: "BRL", proAi: c.proAi, freeAi: c.freeAi } : null
    };
  }
  async function mp(c, path, init = {}) {
    if (!c.mpToken) throw new ApiError(503, "还没开通付费订阅（服务器未配置 MP_ACCESS_TOKEN）", "billing_off");
    const r = await fetchImpl(`${c.mpApi}${path}`, { ...init, headers: { authorization: `Bearer ${c.mpToken}`, "content-type": "application/json", ...init.headers || {} } });
    const text = await r.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
    }
    if (!r.ok) {
      log2(`[billing] MP ${path.split("?")[0]} HTTP ${r.status} ${(j?.message || text).slice(0, 200)}`);
      throw new ApiError(502, `Mercado Pago 返回错误（${r.status}）：${j?.message || "请稍后再试"}`);
    }
    return j;
  }
  async function refreshPreapproval(c, id) {
    const pa = await mp(c, `/preapproval/${encodeURIComponent(id)}`);
    const userId = pa.external_reference;
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new ApiError(400, "订阅缺少用户信息");
    const rows = await db(c, `zq_profiles?user_id=eq.${userId}&select=*`);
    const cur = rows?.[0] ?? { user_id: userId, plan: "free" };
    const patch = { mp_preapproval_id: pa.id, mp_status: pa.status, updated_at: now().toISOString() };
    if (pa.status === "authorized") {
      const next = pa.next_payment_date ? Date.parse(pa.next_payment_date) : NaN;
      const until = Number.isFinite(next) ? next + 3 * 864e5 : now().getTime() + 33 * 864e5;
      const keep = cur.plan_until ? Date.parse(cur.plan_until) : 0;
      patch.plan = "pro";
      patch.plan_until = new Date(Math.max(until, keep)).toISOString();
    }
    await db(c, "zq_profiles", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ ...cur, ...patch }) });
    return { ...cur, ...patch };
  }
  async function checkout(c, request) {
    const user = await requireUser(c, request);
    if (!user.email) throw new ApiError(400, "账号没有邮箱");
    const body = await request.json().catch(() => ({}));
    const back = String(body.returnUrl || "");
    if (!/^https:\/\/[^\s]+$/.test(back) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/.test(back)) throw new ApiError(400, "返回地址必须是 https 网址（在 GitHub Pages 等 https 网站上使用）");
    const profile = await getProfile(c, user);
    if (effectivePlan(c, user, profile) === "pro" && profile.mp_status === "authorized") throw new ApiError(409, "你已经是专业版了");
    const pa = await mp(c, "/preapproval", {
      method: "POST",
      body: JSON.stringify({
        reason: "账期助手 专业版（每月）",
        external_reference: user.id,
        payer_email: user.email,
        back_url: back,
        status: "pending",
        auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: c.price, currency_id: "BRL" }
      })
    });
    await db(c, "zq_profiles", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ ...profile, mp_preapproval_id: pa.id, mp_status: pa.status ?? "pending", updated_at: now().toISOString() })
    });
    if (!pa.init_point) throw new ApiError(502, "Mercado Pago 没有返回付款链接");
    return { url: pa.init_point };
  }
  async function cancel(c, request) {
    const user = await requireUser(c, request);
    const profile = await getProfile(c, user);
    if (!profile.mp_preapproval_id) throw new ApiError(400, "没有进行中的订阅");
    await mp(c, `/preapproval/${encodeURIComponent(profile.mp_preapproval_id)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
    const p = await refreshPreapproval(c, profile.mp_preapproval_id);
    return { status: p.mp_status, planUntil: p.plan_until ?? null };
  }
  async function verifyMpSignature(c, request, dataId) {
    if (!c.mpWebhookSecret) return true;
    const sig = request.headers.get("x-signature") || "";
    const reqId = request.headers.get("x-request-id") || "";
    const parts = Object.fromEntries(sig.split(",").map((p) => p.trim().split("=").map((x) => x.trim())));
    if (!parts.ts || !parts.v1) return false;
    const manifest = `${dataId ? `id:${String(dataId).toLowerCase()};` : ""}${reqId ? `request-id:${reqId};` : ""}ts:${parts.ts};`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(c.mpWebhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.length === parts.v1.length && hex === parts.v1.toLowerCase();
  }
  async function webhook(c, request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const type = String(body.type || body.topic || url.searchParams.get("type") || url.searchParams.get("topic") || "");
    const id = String(body.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
    if (!id) return { ignored: true };
    if (!await verifyMpSignature(c, request, url.searchParams.get("data.id") || id)) throw new ApiError(401, "invalid signature");
    if (/subscription_authorized_payment|authorized_payment/.test(type)) {
      const ap = await mp(c, `/authorized_payments/${encodeURIComponent(id)}`);
      if (ap?.preapproval_id) await refreshPreapproval(c, ap.preapproval_id);
      return { ok: true };
    }
    if (/preapproval/.test(type)) {
      await refreshPreapproval(c, id);
      return { ok: true };
    }
    return { ignored: true };
  }
  async function rememberFnUrl(c, request) {
    const segs = new URL(request.url).pathname.split("/").filter(Boolean);
    const i = segs.indexOf("v1");
    const slug = segs[0] === "functions" && i >= 0 ? segs[i + 1] : segs[0];
    if (!slug || !c.url) return;
    const fnUrl = `${c.url}/functions/v1/${slug}`;
    if (await kvGet(c, "fn_url") !== fnUrl) await kvSet(c, "fn_url", fnUrl);
  }
  async function vapid(c) {
    const raw = await kvGet(c, "vapid");
    if (raw) return JSON.parse(raw);
    const keys = await generateVapidKeys();
    await db(c, "zq_kv", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ key: "vapid", value: JSON.stringify(keys) }) });
    return JSON.parse(await kvGet(c, "vapid") ?? JSON.stringify(keys));
  }
  async function subscribe(c, request) {
    const user = await requireUser(c, request);
    const b = await request.json().catch(() => ({}));
    const endpoint = String(b.endpoint || "");
    const p256dh = String(b.keys?.p256dh || "");
    const auth = String(b.keys?.auth || "");
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1e3 || !p256dh || !auth) throw new ApiError(400, "推送订阅无效");
    await db(c, "zq_push_subs", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ endpoint, user_id: user.id, p256dh, auth, ua: String(request.headers.get("user-agent") || "").slice(0, 200), fails: 0 })
    });
    await rememberFnUrl(c, request).catch(() => {
    });
    return { ok: true };
  }
  async function unsubscribe(c, request) {
    const user = await requireUser(c, request);
    const b = await request.json().catch(() => ({}));
    const endpoint = String(b.endpoint || "");
    await db(c, `zq_push_subs?user_id=eq.${user.id}${endpoint ? `&endpoint=eq.${encodeURIComponent(endpoint)}` : ""}`, { method: "DELETE" });
    return { ok: true };
  }
  async function sendToSubs(c, subs, payload) {
    const keys = await vapid(c);
    let sent = 0;
    for (const s of subs) {
      try {
        const r = await sendPush(s, payload, keys, { subject: c.pushSubject, fetchImpl });
        if (r.ok) {
          sent++;
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "PATCH", body: JSON.stringify({ last_ok: now().toISOString(), fails: 0 }) });
        } else if (r.gone || (s.fails ?? 0) >= 5) {
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" });
        } else {
          log2(`[push] HTTP ${r.status}`);
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "PATCH", body: JSON.stringify({ fails: (s.fails ?? 0) + 1 }) });
        }
      } catch (e) {
        log2(`[push] send failed ${e?.message ?? e}`);
      }
    }
    return sent;
  }
  async function pushTest(c, request) {
    const user = await requireUser(c, request);
    const subs = await db(c, `zq_push_subs?user_id=eq.${user.id}&select=*`);
    if (!subs?.length) throw new ApiError(400, "这台设备还没开启推送");
    const sent = await sendToSubs(c, subs, { title: "账期助手 · 测试推送", body: "关屏推送正常。每天圣保罗时间 09:00 左右提醒到期账单。", tag: "zq-test", url: "./#/bills" });
    return { sent, devices: subs.length };
  }
  function digest(bills, today) {
    const due = bills.filter((b) => !b.deletedAt && !String(b.id).startsWith("sample") && inReminderWindow(b, today));
    if (!due.length) return null;
    const overdue = due.filter((b) => billStatus(b, today) === "overdue");
    due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const total = due.reduce((s, b) => s + openCents(b), 0);
    const lines = due.slice(0, 4).map((b) => `${b.merchantNameSnapshot || "账单"} · ${isPartial(b) ? `还差 ${formatBRL(openCents(b))}` : formatBRL(b.totalCents)} · ${relativeDue(b.dueDate, today)}`);
    if (due.length > 4) lines.push(`…还有 ${due.length - 4} 笔`);
    return {
      title: overdue.length ? `${overdue.length} 笔已逾期 · 共 ${due.length} 笔要处理` : `付款提醒：${due.length} 笔，共 ${formatBRL(total)}`,
      body: lines.join("\n"),
      tag: `zq-digest-${today}`,
      url: "./#/bills/unpaid"
    };
  }
  async function cron(c, request) {
    const token = request.headers.get("x-cron-token") || "";
    const want = await kvGet(c, "cron_token");
    if (!want || token !== want) throw new ApiError(401, "bad cron token");
    const today = todayISO(now());
    const subs = await db(c, "zq_push_subs?select=*") ?? [];
    const byUser = /* @__PURE__ */ new Map();
    subs.forEach((s) => byUser.set(s.user_id, [...byUser.get(s.user_id) ?? [], s]));
    let users = 0;
    let sent = 0;
    for (const [userId, list] of byUser) {
      const key = `${userId}|${today}`;
      const done = await db(c, `zq_push_log?key=eq.${encodeURIComponent(key)}&select=key`);
      if (done?.length) continue;
      const rows = await rpc(c, "zq_push_bills", { p_user: userId }) ?? [];
      const d = digest(rows.map((r) => ({ ...r.data, id: r.id })), today);
      if (!d) continue;
      users++;
      sent += await sendToSubs(c, list, d);
      await db(c, "zq_push_log", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ key }) });
    }
    log2(`[push] cron ${today} users=${users} sent=${sent}`);
    return { users, sent };
  }
  async function route(request, env, sub, cors2) {
    const c = saasConfig(env);
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors2 } });
    const handlers = {
      "GET /me": () => me(c, request),
      "POST /billing/checkout": () => checkout(c, request),
      "POST /billing/cancel": () => cancel(c, request),
      "POST /billing/webhook": () => webhook(c, request),
      "GET /push/key": async () => ({ publicKey: (await vapid(c)).publicKey }),
      "POST /push/subscribe": () => subscribe(c, request),
      "POST /push/unsubscribe": () => unsubscribe(c, request),
      "POST /push/test": () => pushTest(c, request),
      "POST /push/cron": () => cron(c, request)
    };
    const h = handlers[`${request.method} ${sub}`];
    if (!h) return null;
    try {
      return json(200, await h());
    } catch (e) {
      if (!(e instanceof ApiError)) log2(`[saas] ${sub} ${e?.stack ?? e}`);
      return json(e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : "服务器内部错误", code: e?.code });
    }
  }
  async function health(request, env) {
    const c = saasConfig(env);
    let user = null;
    try {
      user = await getUser(c, request);
    } catch {
    }
    return { login: c.allowKeyOnly ? "optional" : "required", signedIn: !!user, billing: !!c.mpToken };
  }
  return { route, authorizeRecognize, health, digest, verifyMpSignature, saasConfig };
}

// supabase/entry.mjs
var log = (m) => console.log(m);
var saas = createSaas({ log });
var handle = createHandler({ prompt: recognize_prompt_default, log, authorize: saas.authorizeRecognize, health: saas.health });
function projectKeys(get) {
  const keys = [];
  try {
    const j = JSON.parse(get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    for (const v of Object.values(j)) if (typeof v === "string" && v) keys.push(v);
  } catch {
  }
  const anon = get("SUPABASE_ANON_KEY");
  if (anon) keys.push(anon);
  return keys;
}
function supabaseEnv(all) {
  const get = (k) => all[k] || "";
  const keys = projectKeys(get);
  const token = [get("ACCESS_TOKEN"), ...keys].filter(Boolean).join(",");
  return { ...all, ACCESS_TOKEN: token, ALLOWED_ORIGINS: get("ALLOWED_ORIGINS") || "*" };
}
var ROUTES = ["/billing/checkout", "/billing/cancel", "/billing/webhook", "/push/key", "/push/subscribe", "/push/unsubscribe", "/push/test", "/push/cron", "/me"];
function cors(req, env) {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim().replace(/\/$/, ""));
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin" };
}
async function serve(req, all) {
  const env = supabaseEnv(all);
  const u = new URL(req.url);
  const path = u.pathname.replace(/\/+$/, "");
  const sub = ROUTES.find((r) => path.endsWith(r));
  if (sub && req.method !== "OPTIONS") {
    const res = await saas.route(req, env, sub, cors(req, env));
    if (res) return res;
  }
  const inner = new Request(new URL(/\/health$/.test(path) ? "/api/health" : "/api/recognize", u.origin).href, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? void 0 : await req.text()
  });
  return await handle(inner, env) ?? new Response("not found", { status: 404 });
}
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve((req) => serve(req, Deno.env.toObject()));
}
export {
  projectKeys,
  serve,
  supabaseEnv
};
