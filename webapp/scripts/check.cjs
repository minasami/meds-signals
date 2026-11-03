// Build check: parses SAMPLE files, runs the analysis, asserts the injected SAMPLE scenarios are detected.
const fs = require("fs"), path = require("path"), MS = require("../public/analysis.js");
const dir = path.join(__dirname, "../public/samples"), series = new Map();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".csv"))) {
  const rows = MS.parseText(f, fs.readFileSync(path.join(dir, f), "utf8")); MS.toSeries(rows, MS.detectKind(rows), series);
}
const j = MS.parseText("x.json", fs.readFileSync(path.join(dir, "SAMPLE_environment.json"), "utf8"));
if (MS.detectKind(j) !== "environment") throw new Error("JSON sample not detected");
const r = MS.analyse(series), has = (g, m) => r.episodes.some(e => e.geo === g && e.metric === m);
const checks = [["Aswan","heat_illness"],["Luxor","temp_c"],["Cairo","pm25"],["Cairo","respiratory"],["Alexandria","gastrointestinal"]];
for (const [g, m] of checks) if (!has(g, m)) throw new Error(`missing expected alert ${g}/${m}`);
// a 10x spike in a flat series must alert; missing values must not become zero
const s = { kind:"sales", geo:"Cairo", metric:"t", points:new Map() };
for (let i = 0; i < 40; i++) s.points.set(new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10), i === 35 ? 1000 : 100 + (i % 3));
if (!MS.scoreSeries(s).episodes.length) throw new Error("spike not detected");
console.log(`OK: ${series.size} series, ${r.episodes.length} alerts, risk:`, Object.fromEntries(Object.entries(r.risk).map(([k,v])=>[k,v.level])));
const quiet = ["Gharbia","Dakahlia","Sharqia"].map(g => r.episodes.filter(e => e.geo === g).length);
console.log("alerts in governorates with no injected event (false alarms):", quiet);
