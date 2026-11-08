// Optional LLM explanation via the Vercel AI Gateway (AI SDK `generateText`).
// Auth: optional AI_GATEWAY_API_KEY override, otherwise an OIDC token so free
// AI Gateway credits work without an API key. OIDC is resolved per request, in order:
// the `x-vercel-oidc-token` header, then `getVercelOidcToken()` from `@vercel/oidc`
// (request context, and it refreshes an expired local token), then `VERCEL_OIDC_TOKEN`
// only when that value is a JWT that has not expired.
// The token is passed into a gateway provider created for that request. Installed
// `@ai-sdk/gateway` sends `apiKey` as the bearer token and then applies `headers`,
// so an OIDC token is passed as `apiKey` with `ai-gateway-auth-method: oidc`.
// Nothing is written to process.env or the runtime request context.
// Optional EXPLAIN_MODEL (default openai/gpt-4o-mini).
// Receives alert summaries only (no rows); stores nothing. Degrades gracefully when not configured.
const MAX_PROMPT = 8000;
const OIDC_HEADER = "x-vercel-oidc-token";
const OIDC_AUTH_METHOD = "ai-gateway-auth-method";
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

// Local-dev fallback only. Matches @vercel/oidc: expired when exp (seconds) is in the past.
// A value that is not a JWT, or has no numeric exp, is not usable.
function unexpiredOidc(token) {
  const trimmed = String(token || "").trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3 || !parts[1]) return "";
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return "";
    if (payload.exp * 1000 < Date.now()) return "";
    return trimmed;
  } catch {
    return "";
  }
}

async function defaultOidcToken() {
  const { getVercelOidcToken } = await import("@vercel/oidc");
  return getVercelOidcToken();
}

// Credential for this request only. Nothing here is written back to the process.
async function resolveAuth(req, getOidcToken) {
  const key = apiKey();
  if (key) return { apiKey: key };
  const fromHeader = headerValue(req, OIDC_HEADER);
  if (fromHeader) return { oidc: fromHeader };
  try {
    const token = await (getOidcToken || defaultOidcToken)();
    if (typeof token === "string" && token.trim()) return { oidc: token.trim() };
  } catch {
    // Missing or unrefreshable token. Fall through to an unexpired env value.
  }
  const fromEnv = unexpiredOidc(process.env.VERCEL_OIDC_TOKEN);
  if (fromEnv) return { oidc: fromEnv };
  return null;
}

// One provider per call. `headers` override the api-key auth method the SDK sets
// whenever `apiKey` is passed (see getGatewayAuthToken in @ai-sdk/gateway).
function gatewayOptions(auth) {
  if (auth.apiKey) return { apiKey: auth.apiKey };
  return { apiKey: auth.oidc, headers: { [OIDC_AUTH_METHOD]: "oidc" } };
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
      const { text } = await ai.generateText({
        model: ai.createGateway(gatewayOptions(auth))(modelId),
        prompt,
        maxOutputTokens: 400,
        abortSignal: AbortSignal.timeout(20000)
      });
      return res.status(200).json({ enabled: true, text: text || null });
    } catch (e) {
      console.error("explain failed:", e && e.name); // never log keys or payloads
      return res.status(500).json({ enabled: true, text: null, error: "AI explanation temporarily unavailable." });
    }
  };
}

export { MAX_PROMPT };
export default createHandler();
