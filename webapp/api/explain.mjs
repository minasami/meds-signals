// Optional LLM explanation via the Vercel AI Gateway (AI SDK `generateText`).
// Auth: optional AI_GATEWAY_API_KEY override, otherwise the Vercel OIDC token so
// free AI Gateway credits work without an API key. On a deployment the token is
// the `x-vercel-oidc-token` request header, not `VERCEL_OIDC_TOKEN`. We read that
// header, then `getVercelOidcToken()` from `@vercel/oidc` (request context, then
// the env var, including local `vercel env pull`). For the duration of the
// generation the token is published where the gateway provider looks (request
// context and `VERCEL_OIDC_TOKEN`) and removed again afterwards.
// Optional EXPLAIN_MODEL (default openai/gpt-4o-mini).
// Receives alert summaries only (no rows); stores nothing. Degrades gracefully when not configured.
const MAX_PROMPT = 8000;
const OIDC_HEADER = "x-vercel-oidc-token";
const REQ_CONTEXT = Symbol.for("@vercel/request-context");
const NOT_CONFIGURED = "AI explanation not configured (set AI_GATEWAY_API_KEY).";

const isAlert = a => Boolean(a) && typeof a === "object" && !Array.isArray(a);
const clean = a => ({
  geo: String(a.geo || "").slice(0, 40),
  metric: String(a.metric || "").slice(0, 40),
  start: String(a.start || "").slice(0, 10),
  end: String(a.end || "").slice(0, 10),
  days: Number(a.days) || 0,
  z: Number(a.z) || 0,
  context: Array.isArray(a.context) ? a.context.slice(0, 5).map(s => String(s).slice(0, 40)) : []
});

export function prepareAlerts(alerts) {
  return (Array.isArray(alerts) ? alerts : []).filter(isAlert).slice(0, 15).map(clean);
}

export function buildPrompt(lang, alerts) {
  const prefix = `You explain public-health early-warning signals for Egypt to non-experts in ${lang === "ar" ? "Arabic" : "English"}. ` +
    `Summarise these statistical alerts in under 150 words. Say clearly that they are early signals, not diagnoses. No medical or treatment claims.\n`;
  let prompt = prefix + JSON.stringify(alerts);
  if (prompt.length > MAX_PROMPT) prompt = prompt.slice(0, MAX_PROMPT);
  return prompt;
}

function headerValue(req, name) {
  const headers = req && req.headers;
  if (!headers || typeof headers !== "object") return "";
  let raw = headers[name];
  if (raw == null) {
    const found = Object.keys(headers).find(k => k.toLowerCase() === name);
    if (found) raw = headers[found];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function apiKey() {
  return String(process.env.AI_GATEWAY_API_KEY || "").trim();
}

async function defaultOidcToken() {
  const { getVercelOidcToken } = await import("@vercel/oidc");
  return getVercelOidcToken();
}

// Credential for this request. API key wins. Otherwise the header, an existing
// env token, or getVercelOidcToken() (request context / local refresh).
async function resolveAuth(req, getOidcToken) {
  const key = apiKey();
  if (key) return { apiKey: key };
  const fromHeader = headerValue(req, OIDC_HEADER);
  if (fromHeader) return { oidc: fromHeader };
  const fromEnv = String(process.env.VERCEL_OIDC_TOKEN || "").trim();
  if (fromEnv) return { oidc: fromEnv };
  try {
    const token = await (getOidcToken || defaultOidcToken)();
    if (typeof token === "string" && token.trim()) return { oidc: token.trim() };
  } catch {
    // Missing token throws; that is the unconfigured state, not a server error.
  }
  return null;
}

// The AI SDK gateway reads OIDC from the request context, then VERCEL_OIDC_TOKEN.
// A classic Node function exposes the token on req.headers, which neither check
// sees, so publish the resolved token for this call only.
async function withRequestOidc(token, fn) {
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "VERCEL_OIDC_TOKEN");
  const prevEnv = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = token;
  const prevCtx = globalThis[REQ_CONTEXT];
  globalThis[REQ_CONTEXT] = {
    get() {
      const base = typeof prevCtx?.get === "function" ? (prevCtx.get() || {}) : {};
      return { ...base, headers: { ...(base.headers || {}), [OIDC_HEADER]: token } };
    }
  };
  try {
    return await fn();
  } finally {
    if (hadEnv) process.env.VERCEL_OIDC_TOKEN = prevEnv;
    else delete process.env.VERCEL_OIDC_TOKEN;
    if (prevCtx === undefined) delete globalThis[REQ_CONTEXT];
    else globalThis[REQ_CONTEXT] = prevCtx;
  }
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return { error: "Invalid JSON." }; }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object." };
  if (body.alerts != null && !Array.isArray(body.alerts)) return { error: "alerts must be an array." };
  return { body };
}

export function createHandler({ loadAi = () => import("ai"), getOidcToken } = {}) {
  return async function handler(req, res) {
    if (req.method === "GET") {
      const auth = await resolveAuth(req, getOidcToken);
      return res.status(200).json({ enabled: Boolean(auth) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    // Reject malformed input even when AI is not configured.
    const parsed = parseBody(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const auth = await resolveAuth(req, getOidcToken);
    if (!auth) return res.status(200).json({ enabled: false, text: null, error: NOT_CONFIGURED });
    try {
      const lang = parsed.body.lang === "ar" ? "ar" : "en";
      const prompt = buildPrompt(lang, prepareAlerts(parsed.body.alerts));
      const modelId = process.env.EXPLAIN_MODEL || "openai/gpt-4o-mini";
      const ai = await loadAi();
      const call = model => ai.generateText({
        model,
        prompt,
        maxOutputTokens: 400,
        abortSignal: AbortSignal.timeout(20000)
      });
      const { text } = auth.apiKey
        ? await call(ai.createGateway({ apiKey: auth.apiKey })(modelId))
        : await withRequestOidc(auth.oidc, () => call(modelId));
      return res.status(200).json({ enabled: true, text: text || null });
    } catch (e) {
      console.error("explain failed:", e && e.name); // never log keys or payloads
      return res.status(500).json({ enabled: true, text: null, error: "AI explanation temporarily unavailable." });
    }
  };
}

export { MAX_PROMPT };
export default createHandler();
