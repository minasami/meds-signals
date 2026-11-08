import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import fs from "node:fs";
import { createHandler, prepareAlerts, buildPrompt, MAX_PROMPT, config, default as handler } from "../api/explain.mjs";

const REQ_CONTEXT = Symbol.for("@vercel/request-context");
const ENV_KEYS = ["AI_GATEWAY_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "VERCEL_OIDC_TOKEN", "EXPLAIN_MODEL"];
const NOT_CONFIGURED = "AI explanation not configured (set AI_GATEWAY_API_KEY).";

function jwt(payload) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.sig`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const liveToken = jwt({ exp: future(), sub: "test" });

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
    assert.deepEqual(res.body, { enabled: false, text: null, error: NOT_CONFIGURED });
  });

  it("reports enabled from the header, a refreshed OIDC token, an unexpired env token, or an API key", async () => {
    clearAuth();
    const runtime = { get: () => ({ headers: { "x-vercel-id": "runtime" } }) };
    globalThis[REQ_CONTEXT] = runtime;
    const res = mockRes();
    await handler({ method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { enabled: false });
    assert.equal(globalThis[REQ_CONTEXT], runtime);

    const headerRes = mockRes();
    await handler({ method: "GET", headers: { "X-Vercel-Oidc-Token": ["", " header-token "] } }, headerRes);
    assert.deepEqual(headerRes.body, { enabled: true });
    assert.equal(JSON.stringify(headerRes.body).includes("header-token"), false);
    assert.equal(globalThis[REQ_CONTEXT], runtime);

    clearAuth();
    process.env.VERCEL_OIDC_TOKEN = "env-token";
    const rawRes = mockRes();
    await handler({ method: "GET", headers: {} }, rawRes);
    assert.deepEqual(rawRes.body, { enabled: false });

    clearAuth();
    process.env.VERCEL_OIDC_TOKEN = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const expiredRes = mockRes();
    await handler({ method: "GET", headers: {} }, expiredRes);
    assert.deepEqual(expiredRes.body, { enabled: false });

    clearAuth();
    globalThis[REQ_CONTEXT] = { get: () => ({ headers: { "x-vercel-oidc-token": liveToken } }) };
    const ctx = globalThis[REQ_CONTEXT];
    const ctxRes = mockRes();
    await handler({ method: "GET", headers: {} }, ctxRes);
    assert.deepEqual(ctxRes.body, { enabled: true });
    assert.equal(globalThis[REQ_CONTEXT], ctx);
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);

    clearAuth();
    process.env.AI_GATEWAY_API_KEY = "key";
    const keyRes = mockRes();
    await handler({ method: "GET", headers: {} }, keyRes);
    assert.deepEqual(keyRes.body, { enabled: true });
  });

  it("uses getVercelOidcToken before an unexpired env token, and ignores env tokens with no exp", async () => {
    clearAuth();
    const fromHelper = jwt({ exp: future(), sub: "helper" });
    const fromEnv = jwt({ exp: future(), sub: "env" });
    process.env.VERCEL_OIDC_TOKEN = fromEnv;
    let helperCalls = 0;
    const prefer = createHandler({
      getOidcToken: async () => { helperCalls += 1; return fromHelper; },
      loadAi: async () => ({
        createGateway(opts) { return modelId => ({ modelId, opts }); },
        async generateText(args) { return { text: args.model.opts.apiKey }; }
      })
    });
    const preferred = mockRes();
    await prefer({ method: "POST", headers: {}, body: { alerts: [] } }, preferred);
    assert.equal(preferred.body.text, fromHelper);
    assert.equal(helperCalls, 1);
    assert.equal(process.env.VERCEL_OIDC_TOKEN, fromEnv);

    const noExp = jwt({ sub: "no-exp" });
    let failed = 0;
    const fallback = createHandler({
      getOidcToken: async () => { failed += 1; throw new Error("refresh failed"); }
    });
    process.env.VERCEL_OIDC_TOKEN = noExp;
    const missingExp = mockRes();
    await fallback({ method: "GET", headers: {} }, missingExp);
    assert.deepEqual(missingExp.body, { enabled: false });

    process.env.VERCEL_OIDC_TOKEN = fromEnv;
    const fresh = mockRes();
    await fallback({ method: "GET", headers: {} }, fresh);
    assert.deepEqual(fresh.body, { enabled: true });
    assert.equal(failed, 2);

    const before = failed;
    const header = mockRes();
    await fallback({ method: "GET", headers: { "x-vercel-oidc-token": " header-token " } }, header);
    assert.deepEqual(header.body, { enabled: true });
    assert.equal(failed, before);
  });

  it("passes an API key to createGateway and prefers it over the OIDC header", async () => {
    clearAuth();
    const runtime = { id: "als" };
    globalThis[REQ_CONTEXT] = runtime;
    process.env.AI_GATEWAY_API_KEY = "gateway-key";
    process.env.EXPLAIN_MODEL = "openai/gpt-4o-mini";
    let gatewayOpts;
    let seen;
    const explain = createHandler({
      getOidcToken: async () => { throw new Error("OIDC should not be required when an API key is set"); },
      loadAi: async () => ({
        createGateway(opts) { gatewayOpts = opts; return modelId => ({ modelId, via: "gateway" }); },
        async generateText(args) {
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
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
    assert.equal(globalThis[REQ_CONTEXT], runtime);
    assert.match(seen.prompt, /English/);
    assert.match(seen.prompt, /early signals, not diagnoses/);
    assert.match(seen.prompt, /Cairo/);
  });

  it("gives that request's gateway the OIDC token without writing shared state", async () => {
    clearAuth();
    const runtime = { id: "als" };
    globalThis[REQ_CONTEXT] = runtime;
    let timeoutMs = 0;
    let gatewayOpts;
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => { timeoutMs = ms; return originalTimeout.call(AbortSignal, ms); };
    const explain = createHandler({
      getOidcToken: async () => { throw new Error("header should win"); },
      loadAi: async () => ({
        createGateway(opts) { gatewayOpts = opts; return modelId => ({ modelId, opts }); },
        async generateText(args) {
          assert.equal(args.model.modelId, "openai/gpt-4o-mini");
          assert.equal(args.model.opts, gatewayOpts);
          assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
          assert.equal(globalThis[REQ_CONTEXT], runtime);
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
      assert.deepEqual(gatewayOpts, { apiKey: liveToken, headers: { "ai-gateway-auth-method": "oidc" } });
      assert.equal(timeoutMs, 20000);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
    assert.equal(globalThis[REQ_CONTEXT], runtime);
    const { getVercelOidcToken } = await import("@vercel/oidc");
    await assert.rejects(() => getVercelOidcToken(), /x-vercel-oidc-token/);
  });

  it("keeps alert limits and still returns 500 without leaking a failed call's token", async () => {
    clearAuth();
    const runtime = { id: "als" };
    globalThis[REQ_CONTEXT] = runtime;
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
    assert.equal(globalThis[REQ_CONTEXT], runtime);
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

  it("sends each overlapping request only its own token and leaves process state unchanged", async () => {
    clearAuth();
    const tokenA = jwt({ exp: future(), sub: "a" });
    const tokenB = jwt({ exp: future(), sub: "b" });
    const runtime = { id: "runtime-als", get: () => ({ headers: { "x-vercel-id": "runtime" } }) };
    globalThis[REQ_CONTEXT] = runtime;
    process.env.VERCEL_OIDC_TOKEN = "sentinel-not-a-jwt";
    const envBefore = JSON.stringify(process.env);

    let waiting = 0;
    let markWaiting;
    const bothWaiting = new Promise(resolve => { markWaiting = resolve; });
    let releaseA;
    let releaseB;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    const gateB = new Promise(resolve => { releaseB = resolve; });
    const calls = [];

    const explain = createHandler({
      getOidcToken: async () => { throw new Error("no shared token"); },
      loadAi: async () => ({
        createGateway(opts) {
          calls.push(opts);
          return modelId => ({ modelId, opts });
        },
        async generateText(args) {
          const own = args.model.opts.apiKey;
          waiting += 1;
          if (waiting === 2) markWaiting();
          await (own === tokenA ? gateA : gateB);
          assert.equal(args.model.opts.apiKey, own);
          assert.deepEqual(args.model.opts.headers, { "ai-gateway-auth-method": "oidc" });
          assert.equal(JSON.stringify(process.env), envBefore);
          assert.equal(globalThis[REQ_CONTEXT], runtime);
          return { text: own };
        }
      })
    });

    const resA = mockRes();
    const resB = mockRes();
    const resU = mockRes();
    const pendingA = explain({ method: "POST", headers: { "x-vercel-oidc-token": tokenA }, body: { alerts: [] } }, resA);
    const pendingU = explain({ method: "POST", headers: {}, body: { alerts: [] } }, resU);
    const pendingB = explain({ method: "POST", headers: { "x-vercel-oidc-token": tokenB }, body: { alerts: [] } }, resB);

    await pendingU;
    assert.equal(resU.statusCode, 200);
    assert.deepEqual(resU.body, { enabled: false, text: null, error: NOT_CONFIGURED });
    assert.equal(JSON.stringify(resU.body).includes(tokenA), false);
    assert.equal(JSON.stringify(resU.body).includes(tokenB), false);
    assert.equal(JSON.stringify(process.env), envBefore);
    assert.equal(globalThis[REQ_CONTEXT], runtime);

    await bothWaiting;
    releaseB();
    await pendingB;
    assert.equal(resB.statusCode, 200);
    assert.equal(resB.body.text, tokenB);
    assert.equal(resA.body, undefined);
    assert.equal(JSON.stringify(process.env), envBefore);
    assert.equal(globalThis[REQ_CONTEXT], runtime);

    releaseA();
    await pendingA;
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.body.text, tokenA);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.apiKey).sort(), [tokenA, tokenB].sort());
    assert.equal(calls[0].headers !== calls[1].headers, true);
    assert.equal(JSON.stringify(process.env), envBefore);
    assert.equal(globalThis[REQ_CONTEXT], runtime);
  });

  it("the installed gateway sends only that request's OIDC bearer", async () => {
    clearAuth();
    const { createGateway, generateText } = await import("ai");
    const tokenA = jwt({ exp: future(), sub: "sdk-a" });
    const tokenB = jwt({ exp: future(), sub: "sdk-b" });
    const sent = [];
    const explain = createHandler({
      getOidcToken: async () => { throw new Error("no"); },
      loadAi: async () => ({
        createGateway(opts) {
          return createGateway({
            ...opts,
            fetch: async (_url, init) => {
              const headers = new Headers(init.headers);
              sent.push({
                authorization: headers.get("authorization"),
                method: headers.get("ai-gateway-auth-method")
              });
              return new Response(JSON.stringify({ error: { message: "stopped" } }), {
                status: 401,
                headers: { "content-type": "application/json" }
              });
            }
          });
        },
        generateText
      })
    });
    const resA = mockRes();
    const resB = mockRes();
    await Promise.all([
      explain({ method: "POST", headers: { "x-vercel-oidc-token": tokenA }, body: { alerts: [] } }, resA),
      explain({ method: "POST", headers: { "x-vercel-oidc-token": tokenB }, body: { alerts: [] } }, resB)
    ]);
    assert.equal(resA.statusCode, 500);
    assert.equal(resB.statusCode, 500);
    assert.equal(JSON.stringify(resA.body).includes(tokenA), false);
    assert.deepEqual(sent.map(s => s.authorization).sort(), [`Bearer ${tokenA}`, `Bearer ${tokenB}`].sort());
    assert.deepEqual(sent.map(s => s.method), ["oidc", "oidc"]);
  });

  it("returns 500 when generation times out or is aborted", async () => {
    clearAuth();
    const runtime = { id: "als" };
    globalThis[REQ_CONTEXT] = runtime;
    const originalTimeout = AbortSignal.timeout;
    const cases = [
      () => AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      () => AbortSignal.abort(new DOMException("The operation was aborted", "AbortError"))
    ];
    try {
      for (const signalOf of cases) {
        AbortSignal.timeout = () => signalOf();
        const explain = createHandler({
          getOidcToken: async () => { throw new Error("no"); },
          loadAi: async () => ({
            createGateway(opts) { return modelId => ({ modelId, opts }); },
            async generateText(args) {
              assert.equal(args.abortSignal.aborted, true);
              throw args.abortSignal.reason;
            }
          })
        });
        const res = mockRes();
        await explain({ method: "POST", headers: { "x-vercel-oidc-token": liveToken }, body: { alerts: [] } }, res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { enabled: true, text: null, error: "AI explanation temporarily unavailable." });
        assert.equal(JSON.stringify(res.body).includes(liveToken), false);
        assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
        assert.equal(globalThis[REQ_CONTEXT], runtime);
      }
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
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

  it("uses a per-request Gemini provider when GOOGLE_GENERATIVE_AI_API_KEY is set", async () => {
    clearAuth();
    const originalTimeout = AbortSignal.timeout;
    const geminiTimeouts = [];
    AbortSignal.timeout = ms => { geminiTimeouts.push(ms); return originalTimeout.call(AbortSignal, ms); };
    try {
    const runtime = { id: "als" };
    globalThis[REQ_CONTEXT] = runtime;
    let gatewayCalls = 0;
    let oidcCalls = 0;
    let waiting = 0;
    let markWaiting;
    const bothWaiting = new Promise(resolve => { markWaiting = resolve; });
    let releaseA;
    let releaseB;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    const gateB = new Promise(resolve => { releaseB = resolve; });
    const providers = [];

    const explain = createHandler({
      getOidcToken: async () => { oidcCalls += 1; return liveToken; },
      loadGoogle: async () => ({
        createGoogleGenerativeAI(opts) {
          const provider = model => ({ provider: "google", modelId: model, apiKey: opts.apiKey });
          providers.push(provider);
          return provider;
        }
      }),
      loadAi: async () => ({
        createGateway() { gatewayCalls += 1; throw new Error("gateway must not run when Gemini is configured"); },
        async generateText(args) {
          const own = args.model.apiKey;
          waiting += 1;
          if (waiting === 2) markWaiting();
          await (own === "key-a" ? gateA : gateB);
          assert.equal(args.model.apiKey, own);
          assert.equal(args.model.provider, "google");
          assert.equal(args.model.modelId, "gemini-flash-latest");
          assert.equal(args.maxOutputTokens, 400);
          assert.equal(geminiTimeouts.at(-1), 25000);
          assert.equal(globalThis[REQ_CONTEXT], runtime);
          return { text: own };
        }
      })
    });

    const enabled = mockRes();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "key-a";
    process.env.AI_GATEWAY_API_KEY = "gateway-key";
    await explain({ method: "GET", headers: { "x-vercel-oidc-token": liveToken } }, enabled);
    assert.deepEqual(enabled.body, { enabled: true });
    assert.equal(oidcCalls, 0);

    const bad = mockRes();
    await explain({ method: "POST", body: "{", headers: {} }, bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, "Invalid JSON.");

    const resA = mockRes();
    const pendingA = explain({
      method: "POST",
      headers: { "x-vercel-oidc-token": liveToken },
      body: { alerts: [] }
    }, resA);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "key-b";
    const resB = mockRes();
    const pendingB = explain({ method: "POST", headers: {}, body: { alerts: [] } }, resB);

    await bothWaiting;
    releaseB();
    await pendingB;
    assert.equal(resB.statusCode, 200);
    assert.equal(resB.body.text, "key-b");
    assert.equal(resA.body, undefined);

    releaseA();
    await pendingA;
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.body.text, "key-a");
    assert.equal(gatewayCalls, 0);
    assert.equal(oidcCalls, 0);
    assert.equal(providers.length, 2);
    assert.equal(providers[0] === providers[1], false);
    assert.equal(globalThis[REQ_CONTEXT], runtime);
    assert.equal(process.env.AI_GATEWAY_API_KEY, "gateway-key");
    assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);

    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.EXPLAIN_MODEL = "gemini-2.0-flash";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "key-c";
    let customModel = "";
    const custom = createHandler({
      loadGoogle: async () => ({
        createGoogleGenerativeAI(opts) {
          assert.equal(opts.apiKey, "key-c");
          return model => ({ modelId: model, apiKey: opts.apiKey });
        }
      }),
      loadAi: async () => ({
        async generateText(args) {
          customModel = args.model.modelId;
          return { text: "custom" };
        }
      })
    });
    const customRes = mockRes();
    await custom({ method: "POST", body: { alerts: [] }, headers: {} }, customRes);
    assert.equal(customRes.body.text, "custom");
    assert.equal(customModel, "gemini-2.0-flash");
    assert.ok(geminiTimeouts.length >= 1);
    assert.ok(geminiTimeouts.every(ms => ms === 25000));
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("logs the provider status on failure and not the key or response body", async () => {
    clearAuth();
    const secret = "AIza-gemini-secret";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = secret;
    const logs = [];
    const original = console.error;
    console.error = (...args) => { logs.push(args); };
    try {
      const explain = createHandler({
        loadGoogle: async () => ({
          createGoogleGenerativeAI(opts) {
            return model => ({ modelId: model, apiKey: opts.apiKey });
          }
        }),
        loadAi: async () => ({
          async generateText(args) {
            const error = new Error("provider said " + args.model.apiKey);
            error.name = "AI_APICallError";
            error.responseBody = args.model.apiKey;
            error.cause = { statusCode: 429, message: args.model.apiKey };
            throw error;
          }
        })
      });
      const res = mockRes();
      await explain({ method: "POST", body: { alerts: [] }, headers: {} }, res);
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { enabled: true, text: null, error: "AI explanation temporarily unavailable." });
      assert.deepEqual(logs, [["explain failed:", "AI_APICallError", 429]]);
      assert.equal(JSON.stringify(logs).includes(secret), false);
    } finally {
      console.error = original;
    }
  });

  it("the installed Google provider sends only that request's API key", async () => {
    clearAuth();
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const { generateText } = await import("ai");
    const sent = [];
    const explain = createHandler({
      getOidcToken: async () => { throw new Error("no oidc"); },
      loadGoogle: async () => ({
        createGoogleGenerativeAI(opts) {
          return createGoogleGenerativeAI({
            ...opts,
            fetch: async (_url, init) => {
              sent.push(new Headers(init.headers).get("x-goog-api-key"));
              return new Response(JSON.stringify({ error: { message: "stopped" } }), {
                status: 400,
                headers: { "content-type": "application/json" }
              });
            }
          });
        }
      }),
      loadAi: async () => ({
        createGateway() { throw new Error("gateway must not run"); },
        generateText
      })
    });
    const logs = [];
    const original = console.error;
    console.error = (...args) => { logs.push(args); };
    try {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "gemini-key-a";
      const resA = mockRes();
      const pendingA = explain({ method: "POST", body: { alerts: [] }, headers: {} }, resA);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "gemini-key-b";
      const resB = mockRes();
      const pendingB = explain({ method: "POST", body: { alerts: [] }, headers: {} }, resB);
      await Promise.all([pendingA, pendingB]);
      assert.equal(resA.statusCode, 500);
      assert.equal(resB.statusCode, 500);
      assert.deepEqual(sent.slice().sort(), ["gemini-key-a", "gemini-key-b"]);
      const flat = JSON.stringify(logs);
      assert.equal(flat.includes("gemini-key-a"), false);
      assert.equal(flat.includes("gemini-key-b"), false);
      assert.match(flat, /400/);
    } finally {
      console.error = original;
    }
  });

  it("allows api/explain to run for at least 30 seconds", () => {
    assert.ok(config.maxDuration >= 30);
    const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.ok(vercel.functions["api/explain.mjs"].maxDuration >= 30);
  });

  it("rejects methods other than GET and POST", async () => {
    clearAuth();
    const res = mockRes();
    await handler({ method: "PUT", body: "{", headers: {} }, res);
    assert.equal(res.statusCode, 405);
    assert.deepEqual(res.body, { error: "Method not allowed" });
  });
});
