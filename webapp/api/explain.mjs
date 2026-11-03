// Optional LLM explanation. Enabled ONLY if an AI_GATEWAY_API_KEY already exists in the project env.
// Receives alert summaries only (no rows); stores nothing.
export default async function handler(req, res) {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (req.method === "GET") return res.status(200).json({ enabled: Boolean(key) });
  if (!key) return res.status(404).json({ error: "LLM explanation not configured" });
  if (req.method !== "POST") return res.status(405).end();
  const { alerts = [], lang = "en" } = req.body || {};
  const prompt = `You explain public-health early-warning signals for Egypt to non-experts in ${lang === "ar" ? "Arabic" : "English"}. ` +
    `Summarise these statistical alerts in under 150 words. Say clearly that they are early signals, not diagnoses. No medical or treatment claims.\n` + JSON.stringify(alerts.slice(0, 15));
  const r = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.EXPLAIN_MODEL || "openai/gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 400 }) });
  const j = await r.json().catch(() => ({}));
  res.status(200).json({ text: j.choices?.[0]?.message?.content || "No explanation available." });
}
