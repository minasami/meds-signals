// Optional LLM explanation via the Vercel AI Gateway (AI SDK `generateText`).
// Auth: AI_GATEWAY_API_KEY, or the Vercel OIDC token (VERCEL_OIDC_TOKEN) that Vercel injects automatically
// on deployments of a project with AI Gateway enabled. Optional EXPLAIN_MODEL (default openai/gpt-4o-mini).
// Receives alert summaries only (no rows); stores nothing. Degrades gracefully when not configured or on errors.
const configured = () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const clean = a => ({ geo: String(a.geo || "").slice(0, 40), metric: String(a.metric || "").slice(0, 40), start: String(a.start || "").slice(0, 10),
  end: String(a.end || "").slice(0, 10), days: Number(a.days) || 0, z: Number(a.z) || 0, context: Array.isArray(a.context) ? a.context.slice(0, 5).map(String) : [] });

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ enabled: configured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!configured()) return res.status(200).json({ enabled: false, text: null, error: "AI explanation not configured (set AI_GATEWAY_API_KEY)." });
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { alerts = [], lang = "en" } = body || {};
  const prompt = `You explain public-health early-warning signals for Egypt to non-experts in ${lang === "ar" ? "Arabic" : "English"}. ` +
    `Summarise these statistical alerts in under 150 words. Say clearly that they are early signals, not diagnoses. No medical or treatment claims.\n` +
    JSON.stringify((Array.isArray(alerts) ? alerts : []).slice(0, 15).map(clean));
  try {
    const { generateText } = await import("ai");
    const { text } = await generateText({ model: process.env.EXPLAIN_MODEL || "openai/gpt-4o-mini", prompt, maxOutputTokens: 400, abortSignal: AbortSignal.timeout(20000) });
    return res.status(200).json({ enabled: true, text: text || null });
  } catch (e) {
    console.error("explain failed:", e && e.name); // never log keys or payloads
    return res.status(200).json({ enabled: true, text: null, error: "AI explanation temporarily unavailable." });
  }
}
