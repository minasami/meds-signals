import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createHandler, prepareAlerts, buildPrompt, MAX_PROMPT, default as handler } from "../api/explain.mjs";

const REQ_CONTEXT = Symbol.for("@vercel/request-context");
const ENV_KEYS = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "EXPLAIN_MODEL"];

function jwt(payload) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.sig`;
}

const liveToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "test" });

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

const savedEnv = new Map(ENV_KEYS.map(k => [k, process.env[k]]));
const savedCtx = globalThis[REQ_CONTEXT];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv.get(key) === undefined) delete process.env[key];
    else process.env[key] = savedEnv.get(key);
  }
  if (savedCtx === undefined) delete globalThis[REQ_CONTEXT];
  else globalThis[REQ_CONTEXT] = savedCtx;
});

function clearAuth() {
  for (const key of ENV_KEYS) delete process.env[key];
  delete globalThis[REQ_CONTEXT];
}

describe("explain api", { concurrency: false }, () => {
  it("rejects malformed input before checking whether AI is configured", async () => {
    clearAuth();
    let oidcCalls = 0;
    let aiLoaded = false;
    const explain = createHandler({
      getOidcToken: async () => { oidcCalls += 1; return liveToken; },
      loadAi: async () => { aiLoaded = true; throw new Error("AI should not load"); }
    });
    const cases = [
      ["{", "Invalid JSON."],
      ["null", "Expected a JSON object."],
      ["[]", "Expected a JSON object."],
      [JSON.stringify({ alerts: "nope" }), "alerts must be an array."],
      [{ alerts: {} }, "alerts must be an array."]
    ];
    for (const [body, error] of cases) {
      const res = mockRes();
      await explain({ method: "POST", body, headers: {} }, res);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error });
    }
    process.env.AI_GATEWAY_API_KEY = "present";
    const res = mockRes();
    await explain({ method: "POST", body: "{", headers: { "x-vercel-oidc-token": liveToken } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid JSON.");
    assert.equal(oidcCalls, 0);
    assert.equal(aiLoaded, false);
  });

  it("returns the unconfigured JSON body only for a valid request", async () => {
    clearAuth();
    const explain = createHandler({ getOidcToken: async () => "" });
    const res = mockRes();
    await explain({ method: "POST", body: { lang: "en", alerts: [] }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      enabled: false,
      text: null,
      error: "AI explanation not configured (set AI_GATEWAY_API_KEY)."
    });
  });

  it("reports enabled from the OIDC header, env, request context, or API key", async () => {
    clearAuth();
    const res = mockRes();
    await handler({ method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { enabled: false });

    const headerRes = mockRes();
    await handler({ method: "GET", headers: { "X-Vercel-Oidc-Token": ["", " header-token "] } }, headerRes);
    assert.deepEqual(headerRes.body, { enabled: true });
    assert.equal(JSON.stringify(headerRes.body).includes("header-token"), false);

    clearAuth();
    process.env.VERCEL_OIDC_TOKEN = "env-token";
    const envRes = mockRes();
    await handler({ method: "GET", headers: {} }, envRes);
    assert.deepEqual(envRes.body, { enabled: true });

    clearAuth();
    globalThis[REQ_CONTEXT] = { get: () => ({ headers: { "x-vercel-oidc-token": liveToken } }) };
    const ctxRes = mockRes();
    await handler({ method: "GET", headers: {} }, ctxRes);
    assert.deepEqual(ctxRes.body, { enabled: true });

    clearAuth();
    process.env.AI_GATEWAY_API_KEY = "key";
    const keyRes = mockRes();
    await handler({ method: "GET", headers: {} }, keyRes);
    assert.deepEqual(keyRes.body, { enabled: true });
  });

  it("passes an API key to createGateway and prefers it over the OIDC header", async () => {
    clearAuth();
    process.env.AI_GATEWAY_API_KEY = "gateway-key";
    process.env.EXPLAIN_MODEL = "openai/gpt-4o-mini";
    let gatewayOpts;
    let seen;
    let duringEnv;
    const explain = createHandler({
      getOidcToken: async () => { throw new Error("OIDC should not be required when an API key is set"); },
      loadAi: async () => ({
        createGateway(opts) { gatewayOpts = opts; return modelId => ({ modelId, via: "gateway" }); },
        async generateText(args) {
          duringEnv = process.env.VERCEL_OIDC_TOKEN;
          seen = args;
          return { text: "A plain-language summary." };
        }
      })
    });
    const res = mockRes();
    await explain({
      method: "POST",
      headers: { "x-vercel-oidc-token": liveToken },
      body: { lang: "en", alerts: [{ geo: "Cairo", metric: "pm25", start: "2026-06-01", end: "2026-06-03", days: 3, z: 4, context: ["dust"] }] }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.text, "A plain-language summary.");
    assert.deepEqual(gatewayOpts, { apiKey: "gateway-key" });
    assert.equal(seen.model.modelId, "openai/gpt-4o-mini");
    assert.equal(seen.maxOutputTokens, 400);
    assert.equal(duringEnv, undefined);
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
    assert.match(seen.prompt, /English/);
    assert.match(seen.prompt, /early signals, not diagnoses/);
    assert.match(seen.prompt, /Cairo/);
  });

  it("gives the gateway the request OIDC token and clears it afterwards", async () => {
    clearAuth();
    const { getVercelOidcToken } = await import("@vercel/oidc");
    let seenToken = "";
    let timeoutMs = 0;
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => { timeoutMs = ms; return originalTimeout.call(AbortSignal, ms); };
    const explain = createHandler({
      loadAi: async () => ({
        createGateway() { throw new Error("OIDC must not be sent as an API key"); },
        async generateText(args) {
          seenToken = await getVercelOidcToken();
          assert.equal(args.model, "openai/gpt-4o-mini");
          assert.equal(process.env.VERCEL_OIDC_TOKEN, liveToken);
          return { text: "" };
        }
      })
    });
    try {
      const res = mockRes();
      await explain({
        method: "POST",
        headers: { "x-vercel-oidc-token": liveToken },
        body: JSON.stringify({ lang: "ar", alerts: [] })
      }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { enabled: true, text: null });
      assert.equal(seenToken, liveToken);
      assert.equal(timeoutMs, 20000);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
    await assert.rejects(() => getVercelOidcToken(), /x-vercel-oidc-token/);

    const failing = createHandler({
      loadAi: async () => ({
        async generateText() { throw new Error("gateway down"); }
      })
    });
    const failed = mockRes();
    await failing({ method: "POST", headers: { "x-vercel-oidc-token": liveToken }, body: { alerts: [] } }, failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
    await assert.rejects(() => getVercelOidcToken(), /x-vercel-oidc-token/);
  });

  it("keeps alert limits and still returns 500 without leaking a failed call's token", async () => {
    clearAuth();
    const long = "abcdefghijklmnopqrstuvwxyz0123456789EXTRA";
    const alerts = Array.from({ length: 16 }, (_, i) => ({
      geo: i === 0 ? long : "G" + i,
      metric: long,
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02extra",
      days: "4",
      z: "2.5",
      context: [long, "b", "c", "d", "e", "dropped"]
    }));
    alerts.push(null, "nope");
    let prompt = "";
    const explain = createHandler({
      loadAi: async () => ({
        createGateway(opts) { return modelId => ({ modelId, apiKey: opts.apiKey }); },
        async generateText(args) {
          prompt = args.prompt;
          assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
          throw new Error("gateway down " + liveToken);
        }
      })
    });
    process.env.AI_GATEWAY_API_KEY = "gateway-key";
    const res = mockRes();
    await explain({ method: "POST", headers: { "x-vercel-oidc-token": liveToken }, body: { alerts } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { enabled: true, text: null, error: "AI explanation temporarily unavailable." });
    assert.equal(JSON.stringify(res.body).includes(liveToken), false);
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
    const json = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
    assert.equal(json.length, 15);
    assert.equal(json[0].geo, long.slice(0, 40));
    assert.equal(json[0].metric.length, 40);
    assert.equal(json[0].start, "2026-06-01");
    assert.equal(json[0].end, "2026-06-02");
    assert.equal(json[0].days, 4);
    assert.equal(json[0].z, 2.5);
    assert.deepEqual(json[0].context, [long.slice(0, 40), "b", "c", "d", "e"]);
    assert.equal(json.some(a => a.geo === "G15"), false);
  });

  it("caps the prompt at 8000 characters", () => {
    assert.equal(MAX_PROMPT, 8000);
    const prepared = prepareAlerts([{ geo: "Cairo", metric: "pm25", context: ["a", "b", "c", "d", "e", "f"] }]);
    assert.equal(prepared[0].context.length, 5);
    const prompt = buildPrompt("en", [{ blob: "x".repeat(9000) }]);
    assert.equal(prompt.length, 8000);
    assert.ok(prompt.startsWith("You explain public-health"));
    const arabic = buildPrompt("ar", []);
    assert.match(arabic, /Arabic/);
  });

  it("rejects methods other than GET and POST", async () => {
    clearAuth();
    const res = mockRes();
    await handler({ method: "PUT", body: "{", headers: {} }, res);
    assert.equal(res.statusCode, 405);
    assert.deepEqual(res.body, { error: "Method not allowed" });
  });
});
