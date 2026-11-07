// Optional LLM explanation via the Vercel AI Gateway (AI SDK `generateText`).
// Auth: AI_GATEWAY_API_KEY, or the Vercel OIDC token (VERCEL_OIDC_TOKEN) that Vercel injects automatically
// on deployments of a project with AI Gateway enabled. Optional EXPLAIN_MODEL (default openai/gpt-4o-mini).
// Receives alert summaries only (no rows); stores nothing. Degrades gracefully when not configured.
const configured = () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const MAX_PROMPT = 8000;
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

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ enabled: configured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!configured()) return res.status(200).json({ enabled: false, text: null, error: "AI explanation not configured (set AI_GATEWAY_API_KEY)." });
  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON." }); }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Expected a JSON object." });
    if (body.alerts != null && !Array.isArray(body.alerts)) return res.status(400).json({ error: "alerts must be an array." });
    const lang = body.lang === "ar" ? "ar" : "en";
    const alerts = (Array.isArray(body.alerts) ? body.alerts : []).filter(isAlert).slice(0, 15).map(clean);
    const prefix = `You explain public-health early-warning signals for Egypt to non-experts in ${lang === "ar" ? "Arabic" : "English"}. ` +
      `Summarise these statistical alerts in under 150 words. Say clearly that they are early signals, not diagnoses. No medical or treatment claims.\n`;
    let prompt = prefix + JSON.stringify(alerts);
    if (prompt.length > MAX_PROMPT) prompt = prompt.slice(0, MAX_PROMPT);
    const { generateText } = await import("ai");
    const { text } = await generateText({ model: process.env.EXPLAIN_MODEL || "openai/gpt-4o-mini", prompt, maxOutputTokens: 400, abortSignal: AbortSignal.timeout(20000) });
    return res.status(200).json({ enabled: true, text: text || null });
  } catch (e) {
    console.error("explain failed:", e && e.name); // never log keys or payloads
    return res.status(500).json({ enabled: true, text: null, error: "AI explanation temporarily unavailable." });
  }
}
