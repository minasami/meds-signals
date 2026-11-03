/* meds-signals analysis core. Runs in the browser (and in Node for tests). No network. */
(function (root) {
  const GOV = {"Cairo":[30.04,31.24],"Giza":[30.01,31.21],"Alexandria":[31.20,29.92],"Qalyubia":[30.41,31.18],"Dakahlia":[31.04,31.38],"Sharqia":[30.59,31.50],"Gharbia":[30.79,30.99],"Monufia":[30.55,30.99],"Beheira":[30.85,30.35],"Kafr El Sheikh":[31.11,30.94],"Damietta":[31.42,31.81],"Port Said":[31.26,32.30],"Ismailia":[30.60,32.27],"Suez":[29.97,32.53],"Faiyum":[29.31,30.84],"Beni Suef":[29.07,31.10],"Minya":[28.11,30.75],"Assiut":[27.18,31.18],"Sohag":[26.56,31.69],"Qena":[26.16,32.73],"Luxor":[25.69,32.64],"Aswan":[24.09,32.90],"Red Sea":[27.26,33.81],"New Valley":[25.45,30.55],"Matrouh":[31.35,27.24],"North Sinai":[31.13,33.80],"South Sinai":[28.24,33.62]};
  const ALIAS = {"cai":"Cairo","al qahirah":"Cairo","القاهرة":"Cairo","gza":"Giza","الجيزة":"Giza","alx":"Alexandria","alexandria":"Alexandria","الإسكندرية":"Alexandria","الاسكندرية":"Alexandria","ast":"Assiut","asyut":"Assiut","أسيوط":"Assiut","fayoum":"Faiyum","qalyubiya":"Qalyubia","sharkia":"Sharqia","menofia":"Monufia","kafr el-sheikh":"Kafr El Sheikh","asw":"Aswan","أسوان":"Aswan","lxr":"Luxor","الأقصر":"Luxor"};
  const norm = s => String(s ?? "").trim();
  function canonGeo(s) {
    const t = norm(s); if (!t) return "";
    const l = t.toLowerCase();
    for (const g of Object.keys(GOV)) if (g.toLowerCase() === l) return g;
    return ALIAS[l] || ALIAS[t] || t;
  }
  function parseCSV(text) {
    const rows = []; let row = [], f = "", q = false;
    text = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    const nonEmpty = rows.filter(r => r.some(x => x.trim() !== ""));
    if (!nonEmpty.length) return [];
    const h = nonEmpty[0].map(x => x.trim().toLowerCase());
    return nonEmpty.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
  }
  function parseText(name, text) {
    if (/\.json$/i.test(name) || /^\s*[\[{]/.test(text)) {
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : (j.rows || j.data || []);
      return arr.map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])));
    }
    return parseCSV(text);
  }
  function detectKind(rows) {
    const k = new Set(Object.keys(rows[0] || {}));
    if (k.has("units") || k.has("sales")) return "sales";
    if (k.has("absences") || k.has("headcount")) return "workplace";
    if (k.has("temp_c") || k.has("pm25") || k.has("temperature")) return "environment";
    return null;
  }
  const num = v => { const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };
  const isoDate = v => { const d = new Date(String(v).slice(0, 10) + "T00:00:00Z"); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

  /** Turn rows into series: key -> {kind, geo, metric, points: Map(date->value), lat, lon} */
  function toSeries(rows, kind, out = new Map(), coords = {}) {
    for (const r of rows) {
      const date = isoDate(r.date ?? r.day ?? r.week_start); if (!date) continue;
      const geo = canonGeo(r.governorate ?? r.area ?? r.geo ?? r.region); if (!geo) continue;
      const la = num(r.lat), lo = num(r.lon ?? r.lng);
      if (Number.isFinite(la) && Number.isFinite(lo)) coords[geo] = [la, lo];
      const add = (metric, v) => {
        if (!Number.isFinite(v)) return;            // missing stays missing, never 0
        const key = kind + "|" + geo + "|" + metric;
        if (!out.has(key)) out.set(key, { kind, geo, metric, points: new Map() });
        const p = out.get(key).points; p.set(date, (p.get(date) || 0) + v);
      };
      if (kind === "sales") add(norm(r.category || r.ingredient || "all").toLowerCase(), num(r.units ?? r.sales));
      if (kind === "environment") { add("temp_c", num(r.temp_c ?? r.temperature)); add("pm25", num(r.pm25)); }
      if (kind === "workplace") {
        const hc = num(r.headcount), ab = num(r.absences);
        if (Number.isFinite(hc) && hc > 0 && Number.isFinite(ab)) add("absence_rate_pct", 100 * ab / hc);
        else add("absences", ab);
        add("complaints", num(r.heat_or_breathing_complaints ?? r.complaints));
      }
    }
    return out;
  }
  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
  const THRESH = { temp_c: 40, pm25: 75 };

  /** Robust, day-of-week-adjusted trailing z-score. Causal: day t only uses days before t. */
  function scoreSeries(s, opt = {}) {
    const W = opt.window || 28, ZT = opt.z || 3, ZH = opt.zHigh || 5;
    const dates = [...s.points.keys()].sort(), vals = dates.map(d => s.points.get(d));
    const dows = dates.map(d => new Date(d + "T00:00:00Z").getUTCDay());
    const res = [];
    for (let i = 0; i < dates.length; i++) {
      const lo = Math.max(0, i - W), base = vals.slice(lo, i);
      let z = null, expected = null;
      if (base.length >= 14) {
        const med = median(base);
        const mad = median(base.map(v => Math.abs(v - med))) * 1.4826;
        // weekday factor: median of same-weekday values / overall median (seasonal baseline)
        const same = []; for (let j = lo; j < i; j++) if (dows[j] === dows[i]) same.push(vals[j]);
        const wf = same.length >= 3 && med > 0 ? median(same) / med : 1;
        expected = med * wf;
        const scale = Math.max(mad, Math.sqrt(Math.max(expected, 0)) * 0.5, Math.abs(expected) * 0.02, 1e-6);
        z = (vals[i] - expected) / scale;
      }
      const absHit = THRESH[s.metric] != null && vals[i] >= THRESH[s.metric];
      res.push({ date: dates[i], value: vals[i], expected, z, unusual: (z != null && z >= ZT) || absHit, strong: (z != null && z >= ZH) || absHit, absHit });
    }
    // episodes: >=2 consecutive unusual days, or a single strong day
    const eps = []; let cur = null;
    const flush = () => { if (cur && (cur.days.length >= 2 || cur.days.some(d => d.strong))) eps.push(cur); cur = null; };
    for (const r of res) { if (r.unusual) { (cur ||= { days: [] }).days.push(r); } else flush(); }
    flush();
    return { res, episodes: eps.map(e => {
      const peak = e.days.reduce((a, b) => ((b.z ?? 0) > (a.z ?? 0) ? b : a));
      const maxZ = Math.max(...e.days.map(d => d.z ?? 0));
      const sev = maxZ >= 6 || e.days.length >= 5 ? 3 : maxZ >= 4 || e.days.length >= 3 || e.days.some(d => d.absHit) ? 2 : 1;
      return { kind: s.kind, geo: s.geo, metric: s.metric, start: e.days[0].date, end: e.days.at(-1).date, days: e.days.length,
        peakValue: peak.value, expected: peak.expected, maxZ: Math.round(maxZ * 10) / 10, absHit: e.days.some(d => d.absHit), severity: sev };
    }) };
  }

  function analyse(seriesMap, opt) {
    let all = [], lastDate = "";
    for (const s of seriesMap.values()) {
      const { episodes, res } = scoreSeries(s, opt);
      all.push(...episodes); if (res.length && res.at(-1).date > lastDate) lastDate = res.at(-1).date;
    }
    // Fusion: a sales/workplace episode that overlaps an environmental episode in the same area (±3 days) is upgraded and linked
    const env = all.filter(e => e.kind === "environment");
    for (const e of all) if (e.kind !== "environment") {
      const sh = (d, k) => new Date(new Date(d + "T00:00:00Z") - -k * 864e5).toISOString().slice(0, 10);
      const ctx = env.filter(v => v.geo === e.geo && v.start <= sh(e.end, 3) && v.end >= sh(e.start, -3));
      if (ctx.length) { e.context = [...new Set(ctx.map(c => c.metric))]; e.severity = Math.min(3, e.severity + 1); }
    }
    all.sort((a, b) => b.end.localeCompare(a.end) || b.severity - a.severity);
    // Area risk over the last 14 days of data
    const cutoff = lastDate ? new Date(new Date(lastDate) - 13 * 864e5).toISOString().slice(0, 10) : "";
    const risk = {};
    for (const s of seriesMap.values()) risk[s.geo] ||= { level: 0, n: 0 };
    for (const e of all) if (e.end >= cutoff) { const r = risk[e.geo]; r.n++; r.level = Math.max(r.level, e.severity); }
    return { episodes: all, risk, lastDate, cutoff };
  }
  const api = { GOV, canonGeo, parseCSV, parseText, detectKind, toSeries, scoreSeries, analyse };
  if (typeof module !== "undefined") module.exports = api; else root.MS = api;
})(this);
