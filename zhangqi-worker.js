// 账期助手识别服务 · Cloudflare Worker（由 npm run build:worker 生成，请勿手改）

// shared/recognize-prompt.txt
var recognize_prompt_default = '你是一名严谨的票据录入员。图片是巴西一家小公司收到的一张单据，可能是以下任意一种：\n- order：商家的手写或打印订单（Pedido、收据，可能含中文、葡萄牙语、数字和字母型号，蓝色表格线、阴影、透视变形）\n- boleto：银行付款单（Boleto / Ficha de Compensação，有银行代码、47 位数字线、条码、Vencimento、Valor do Documento）\n- utility：水、电、燃气、网络、电话账单（如 Sabesp、Enel、Comgás、Vivo），通常有"Total a pagar""Vencimento"、二维码或 48 位数字线\n- tax：税费或政府缴费单（DAS、DARF、GPS、FGTS Digital/GFD、IPTU 等）\n- payslip：工资单（Recibo de Pagamento de Salário）\n- statement：对账单 / 欠款明细表（一张表里有多笔订单和付款记录，例如供应商发来的 Excel 截图）\n- receipt：其他收据或单据\n\n任务：逐字读取单据，只输出一个符合下列 Schema 的 JSON 对象，不要输出任何其他文字。\n\n{\n  "docType": "order"|"boleto"|"utility"|"tax"|"payslip"|"statement"|"receipt",\n  "merchant": {"value": string|null, "confidence": 0..1, "candidates": [string]},\n  "orderNumber": {"value": string|null, "confidence": 0..1},\n  "billDate": {"raw": string|null, "iso": "YYYY-MM-DD"|null, "confidence": 0..1},\n  "dueDate": {"raw": string|null, "iso": "YYYY-MM-DD"|null, "confidence": 0..1},\n  "amountDue": {"raw": string|null, "cents": integer|null, "confidence": 0..1},\n  "paymentLine": string|null,\n  "pixCode": string|null,\n  "referenceMonth": string|null,\n  "categoryHint": "water"|"electricity"|"gas"|"internet"|"phone"|"rent"|"condo"|"tax"|"payroll"|"accounting"|"logistics"|"platform"|"loan"|"subscription"|"other"|null,\n  "items": [\n    {"row": 1, "quantity": number|null, "boxes": number|null, "perBox": number|null,\n     "description": string|null,\n     "unitPriceRaw": string|null, "unitPriceCents": integer|null,\n     "printedSubtotalRaw": string|null, "printedSubtotalCents": integer|null,\n     "confidence": 0..1, "needsReview": boolean,\n     "bbox": [x, y, w, h] | null}\n  ],\n  "printedTotalRaw": string|null,\n  "printedTotalCents": integer|null,\n  "statement": {\n    "entries": [{"date": "YYYY-MM-DD"|null, "dateRaw": string|null, "orderNumber": string|null, "cents": integer|null, "raw": string|null, "paid": boolean|null}],\n    "payments": [{"date": "YYYY-MM-DD"|null, "cents": integer|null, "note": string|null}],\n    "balanceCents": integer|null\n  } | null,\n  "unparsedLines": [string],\n  "warnings": [string]\n}\n\n字段说明：\n- merchant：收款方。订单写商家名；boleto 写 Beneficiário（受益人/收款公司）；水电账单写公司名（如 "Enel"）；税费写税种（如 "FGTS"、"DAS"）；工资单写员工姓名；对账单写对方名称或表头上的客户编号（如 "KH-3913"）。不要写付款人（Pagador / 本公司）。\n- dueDate：Vencimento / "Pagar até"。工资单没有到期日时为 null。\n- amountDue：本单应付金额。boleto 取 "Valor do Documento"；水电取 "Total a pagar"；税费取 "Valor a recolher / Total"；工资单取 "Líquido a receber"；订单取总额。\n- paymentLine：如果单据上印有数字线（linha digitável，47 或 48 位，常见格式如 "34191.09008 04545.379275 90742.810006 9 16010000314822"），逐位照抄；没有或看不清就 null。绝不编造或补全任何一位。\n- pixCode：如果印有 "PIX Copia e Cola" 文字，原样照抄；二维码图片本身不要尝试解码，填 null。\n- referenceMonth：账单所属月份原文（如 "SET/2026"、"Setembro/2026"、"OUTUBRO 2026"）。\n- items：订单逐行明细；boleto / 水电单上的分项（如 "ALUGUEL 1.700,00"、"CONDOMINIO 1.448,22"）每项一行，quantity 填 1，金额写进 unitPrice 和 printedSubtotal。工资单、只有一个总额的单据 items 可为空数组。\n- 手写订单常见写法「箱数 × 每箱件数 × 单价 = 小计」（例如 "2 × 50 × 19 = 1900"）：boxes 填 2、perBox 填 50、quantity 填总件数 100、unitPrice 填 19。只有「数量 × 单价」时 boxes、perBox 为 null。\n- statement：只有 docType 为 statement 时填写。每笔订单/欠款一条 entry；paid 根据表格里的已付标记（颜色、对勾、对应付款）判断，看不出来就 null；payments 是付款记录表里的每一行；balanceCents 是"结欠/Saldo devedor"。其他类型填 null。\n\n硬性规则：\n1. 逐字读取并保留原文。*Raw 字段照抄图片上的写法（例如 "8"、"15,00"、"1.234,56"）。\n2. 看不清就返回 null，并把 needsReview 设为 true，confidence 如实降低。绝不猜测。\n3. 型号/描述按图片原样保留大小写、连字符、空格、中文和数字（如 "FN-A78"、"CA31-3"、"800ml 黑"），不得根据常识补全或"纠正"。\n4. 金额是巴西雷亚尔：逗号是小数点，点是千位分隔（Excel 截图里若明显用点做小数点、逗号做千位，如 "2,808.00"，按截图的写法换算并在 warnings 说明）。*Cents 为整数分（"8" → 800，"1.234,56" → 123456）。无法确定格式时 *Cents 返回 null 并在 warnings 说明。\n5. 不得为了让小计或总额相等而修改任何识别到的数字；算术不一致、总额被涂改或有两个不同的总额时照实输出，并在 warnings 里说明。\n6. 订单号、单号保留前导零，作为字符串输出。\n7. 日期：raw 照抄；只有年份写全（4 位）且日期真实存在时才填 iso，否则 iso 为 null。\n8. 任何包含数字但你无法可靠拆成明细的行，原样放入 unparsedLines，不要丢弃。\n9. bbox 是该明细行在图片中的归一化位置（0–1，左上为原点）；无法确定则为 null。\n10. 只描述这张图片里真实存在的内容；表头、签名、旁边纸张上的内容不要当作明细。\n';

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
function createHandler({ prompt, log = () => {
} }) {
  const hits = /* @__PURE__ */ new Map();
  const cfg = (env) => ({
    apiKey: env.ANTHROPIC_API_KEY || "",
    model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
    apiUrl: env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages",
    origins: String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
    token: env.ACCESS_TOKEN || "",
    maxBytes: Number(env.MAX_IMAGE_BYTES || 6 * 1024 * 1024),
    timeout: Number(env.RECOGNIZE_TIMEOUT_MS || 9e4),
    rate: Number(env.RATE_PER_MIN || 10)
  });
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
        "access-control-allow-headers": "content-type,x-access-token",
        "access-control-max-age": "86400"
      };
    }
    return {};
  }
  const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
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
    const { mediaType, imageBase64 } = payload || {};
    if (!MEDIA_TYPES.has(mediaType)) throw new HttpError(415, "只接受 JPG、PNG、WebP 图片");
    if (typeof imageBase64 !== "string" || !imageBase64 || !/^[A-Za-z0-9+/=]+$/.test(imageBase64)) throw new HttpError(400, "图片数据无效");
    if (imageBase64.length * 3 / 4 > c.maxBytes) throw new HttpError(413, "图片过大");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeout);
    let r;
    try {
      r = await fetch(c.apiUrl, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: c.model,
          max_tokens: 6e3,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
                { type: "text", text: prompt }
              ]
            }
          ]
        })
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new HttpError(504, "识别超时，请重试或裁小图片");
      throw new HttpError(502, "连接视觉模型失败");
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      log(`[recognize] upstream HTTP ${r.status}`);
      if (r.status === 401 || r.status === 403) throw new HttpError(502, "模型密钥无效或没有权限，请检查服务器上的 ANTHROPIC_API_KEY");
      if (r.status === 429) throw new HttpError(429, "模型服务繁忙或额度不足，请稍后再试");
      if (r.status === 404) throw new HttpError(502, `模型「${c.model}」不可用，请检查 ANTHROPIC_MODEL`);
      throw new HttpError(502, `模型服务出错（${r.status}）`);
    }
    const data = await r.json();
    const text = (data.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
    const result = extractJson(text);
    if (!result || typeof result !== "object" || !Array.isArray(result.items)) throw new HttpError(502, "模型没有返回符合格式的 JSON，请重试");
    return { result, rawText: text.slice(0, 2e4), model: c.model };
  }
  return async function handle2(request, env = {}) {
    const c = cfg(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return null;
    const cors = corsHeaders(request, c);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const tokenOk = !c.token || safeEqual(request.headers.get("x-access-token") || "", c.token);
    if (url.pathname === "/api/health") {
      return json(200, { ok: true, configured: Boolean(c.apiKey), model: c.apiKey ? c.model : null, auth: Boolean(c.token), tokenOk }, cors);
    }
    if (url.pathname === "/api/recognize") {
      if (request.method !== "POST") return json(405, { error: "只支持 POST" }, cors);
      if (!c.apiKey) return json(503, { error: "服务器未配置 ANTHROPIC_API_KEY" }, cors);
      const ip = request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
      if (!tokenOk) {
        if (rateLimited(`bad:${ip}`, 5)) return json(429, { error: "口令错误次数过多，请稍后再试" }, cors);
        return json(401, { error: "访问口令不正确，请在「设置 → 识别服务」里填写" }, cors);
      }
      if (rateLimited(ip, c.rate)) return json(429, { error: "请求太频繁，请一分钟后再试" }, cors);
      try {
        const t0 = Date.now();
        const out = await recognize(request, c);
        log(`[recognize] ok ${Date.now() - t0}ms items=${out.result.items.length}`);
        return json(200, out, cors);
      } catch (e) {
        return json(e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : "服务器内部错误" }, cors);
      }
    }
    return json(404, { error: "not found" }, cors);
  };
}

// worker/entry.mjs
var handle = createHandler({ prompt: recognize_prompt_default, log: (m) => console.log(m) });
var entry_default = {
  async fetch(request, env) {
    const res = await handle(request, env);
    if (res) return res;
    return new Response("账期助手识别服务运行中。请在应用「设置 → 识别服务」填写：" + new URL("/api/recognize", request.url).href, {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
export {
  entry_default as default
};
