(function () {
  const $ = s => document.querySelector(s);
  let geo = null, geoLayer, lang = "en", series = new Map(), coords = {}, result = null, map, layer, loaded = [];
  const T = {
    en: {}, // English text lives in the HTML
    ar: { skip:"تخطَّ إلى المحتوى", tagline:"إشارة مبكرة وليست تشخيصًا", disclaimer:"تعرض هذه الأداة إشارات إحصائية مبكرة من بيانات مجمّعة. هي ليست تشخيصًا ولا نصيحة طبية. في الطوارئ اتصل بالإسعاف 123.",
      upload:"1. تحميل البيانات", uploadHelp:"اختر ملفات CSV أو JSON. تُقرأ الملفات داخل متصفحك فقط، ولا يُرفع أو يُخزَّن أي شيء.", choose:"اختر الملفات (مبيعات الصيدليات، البيئة، أماكن العمل)",
      samples:"تحميل بيانات نموذجية (اصطناعية)", clear:"مسح", formats:"الأعمدة المتوقعة والملفات النموذجية", alerts:"2. التنبيهات",
      method:"الطريقة: تُقارن كل سلسلة بخط أساس متحرك لـ28 يومًا (الوسيط وMAD) مع تعديل يوم الأسبوع. اليوم غير المعتاد عندما تكون قيمة z ≥ 3، ويحتاج التنبيه يومين متتاليين (أو z ≥ 5 مرة واحدة). وتُنبّه القراءات البيئية أيضًا عند حدود ثابتة (حرارة ≥ 40° م، PM2.5 ≥ 75).",
      map:"3. خريطة المخاطر (آخر 14 يومًا من البيانات)", l0:"لا إشارة", l1:"مراقبة", l2:"مرتفع", l3:"عالٍ", tableCap:"مستوى الإشارة حسب المنطقة (نسخة نصية من الخريطة)", area:"المنطقة", level:"المستوى", nAlerts:"تنبيهات نشطة",
      advice:"4. نصائح وقائية", ai:"شرح اختياري بالذكاء الاصطناعي", aiHelp:"يُرسل ملخصات التنبيهات فقط (بدون صفوف) إلى نموذج لغوي، عند الضغط فقط.", aiBtn:"اشرح التنبيهات",
      foot:"نموذج أولي لتحدي Future Health. البيانات النموذجية اصطناعية. الخريطة © مساهمو OpenStreetMap." }
  };
  const EN = {}; document.querySelectorAll("[data-i18n]").forEach(el => EN[el.dataset.i18n] = el.textContent);
  const LV = { en: ["no signal","watch","elevated","high"], ar: ["لا إشارة","مراقبة","مرتفع","عالٍ"] };
  const M = {
    respiratory:{en:"respiratory medicine sales",ar:"مبيعات أدوية الجهاز التنفسي"}, gastrointestinal:{en:"stomach/diarrhoea medicine sales",ar:"مبيعات أدوية المعدة والإسهال"},
    allergy:{en:"allergy medicine sales",ar:"مبيعات أدوية الحساسية"}, heat_illness:{en:"heat-related product sales (ORS, cooling)",ar:"مبيعات منتجات الإجهاد الحراري (أملاح الإرواء)"},
    temp_c:{en:"temperature (°C)",ar:"درجة الحرارة (°م)"}, pm25:{en:"PM2.5 air pollution (µg/m³)",ar:"تلوث الهواء PM2.5"},
    absence_rate_pct:{en:"workplace absence rate (%)",ar:"نسبة الغياب في العمل (%)"}, absences:{en:"workplace absences",ar:"حالات الغياب"}, complaints:{en:"workplace heat/breathing complaints",ar:"شكاوى الحرارة/التنفس في العمل"}
  };
  const mname = m => (M[m] || { en: m.replace(/_/g," "), ar: m })[lang];
  const ADV = {
    heat:{t:{en:"Heat",ar:"الحرارة"},metrics:["temp_c","heat_illness"],en:["Drink water regularly, even before feeling thirsty.","Avoid outdoor work 11:00–16:00; schedule shaded breaks.","Check on older people, children and people with chronic illness.","Seek care for confusion, fainting or very high body temperature."],ar:["اشرب الماء بانتظام حتى قبل الشعور بالعطش.","تجنّب العمل في الخارج من 11 صباحًا حتى 4 مساءً، وخذ فترات راحة في الظل.","اطمئن على كبار السن والأطفال وأصحاب الأمراض المزمنة.","اطلب الرعاية عند الارتباك أو الإغماء أو ارتفاع حرارة الجسم الشديد."]},
    air:{t:{en:"Air quality / respiratory",ar:"جودة الهواء والجهاز التنفسي"},metrics:["pm25","respiratory","allergy"],en:["Limit outdoor exercise on dusty or smoky days.","Keep windows closed during dust storms; a well-fitted mask can help outdoors.","People with asthma should keep their usual inhaler with them and follow their care plan.","Cover coughs and stay home when ill."],ar:["قلّل الرياضة في الخارج في الأيام المتربة أو الملوثة.","أغلق النوافذ أثناء العواصف الترابية، وقد تفيد الكمامة الملائمة في الخارج.","على مرضى الربو حمل البخاخ المعتاد واتباع خطة العلاج.","غطِّ فمك عند السعال وابقَ في المنزل عند المرض."]},
    gi:{t:{en:"Food and water hygiene",ar:"سلامة الغذاء والمياه"},metrics:["gastrointestinal"],en:["Wash hands with soap before eating and after the toilet.","Use safe drinking water; keep food cold and cook it thoroughly.","Use oral rehydration salts for diarrhoea; seek care for blood, high fever or signs of dehydration."],ar:["اغسل يديك بالصابون قبل الأكل وبعد استخدام الحمام.","استخدم مياه شرب آمنة، واحفظ الطعام باردًا واطهه جيدًا.","استخدم أملاح الإرواء عند الإسهال، واطلب الرعاية عند وجود دم أو حمى شديدة أو جفاف."]},
    work:{t:{en:"Workplaces",ar:"أماكن العمل"},metrics:["absence_rate_pct","absences","complaints"],en:["Share this signal with occupational health or HR as a heads-up, not a diagnosis.","Adjust shifts, ventilation and water access during heat or dust episodes.","Encourage staff with symptoms to rest and seek care."],ar:["شارك هذه الإشارة مع الصحة المهنية أو الموارد البشرية كتنبيه وليس تشخيصًا.","عدّل الورديات والتهوية وتوفير المياه أثناء موجات الحر أو الغبار.","شجّع العاملين ذوي الأعراض على الراحة وطلب الرعاية."]}
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const status = (msg, err) => { const s = $("#status"); s.textContent = msg; s.className = err ? "err" : ""; };

  function applyLang() {
    document.documentElement.lang = lang; document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach(el => { const k = el.dataset.i18n; el.textContent = (lang === "ar" ? T.ar[k] : EN[k]) || EN[k]; });
    $("#lang").textContent = lang === "ar" ? "English" : "العربية";
    render();
  }
  function ingest(name, text) {
    const rows = MS.parseText(name, text);
    if (!rows.length) throw new Error(name + ": no rows found");
    const kind = MS.detectKind(rows);
    if (!kind) throw new Error(name + ": columns not recognised (see expected columns)");
    const banned = Object.keys(rows[0]).filter(k => /patient|national_id|nid|phone|name_of|prescriber|rx_id|mrn/.test(k));
    if (banned.length) throw new Error(name + ": looks like personal/patient data (" + banned.join(", ") + "). Upload aggregated counts only.");
    MS.toSeries(rows, kind, series, coords);
    loaded.push(name + " (" + kind + ", " + rows.length + " rows)");
  }
  function run() {
    result = MS.analyse(series);
    status((lang === "ar" ? "تم التحميل: " : "Loaded: ") + loaded.join("; ") + " — " + result.episodes.length + (lang === "ar" ? " تنبيه" : " alerts"));
    render();
  }
  function alertText(e) {
    const ratio = e.expected > 0 ? (e.peakValue / e.expected) : null;
    const pct = ratio ? Math.round((ratio - 1) * 100) : null;
    const v = Math.round(e.peakValue * 10) / 10, ex = e.expected != null ? Math.round(e.expected * 10) / 10 : "–";
    if (lang === "ar") return `ارتفعت ${mname(e.metric)} في ${e.geo} بشكل غير معتاد لمدة ${e.days} يوم (${e.start} إلى ${e.end}). الذروة ${v} مقابل ${ex} متوقع` + (pct != null ? ` (+${pct}%)` : "") + `. هذه إشارة مبكرة وليست تشخيصًا.`;
    return `${mname(e.metric)[0].toUpperCase() + mname(e.metric).slice(1)} in ${e.geo} were unusually high for ${e.days} day${e.days > 1 ? "s" : ""} (${e.start} to ${e.end}). Peak ${v} vs about ${ex} expected` + (pct != null ? ` (+${pct}%)` : "") + `. This is an early signal, not a diagnosis.`;
  }
  function render() {
    const A = $("#alerts"), V = $("#advice");
    if (!result) { A.innerHTML = `<p class="muted">${lang === "ar" ? "حمّل بيانات لرؤية التنبيهات." : "Load data to see alerts."}</p>`; V.innerHTML = ""; drawMap(); return; }
    const eps = result.episodes.slice(0, 30);
    A.innerHTML = eps.length ? eps.map(e => `<article class="alert s${e.severity}" aria-label="${esc(LV[lang][e.severity])}: ${esc(e.geo)}">
      <h3><span class="badge s${e.severity}">${esc(LV[lang][e.severity])}</span> ${esc(e.geo)} · ${esc(mname(e.metric))}</h3>
      <p>${esc(alertText(e))}</p>
      ${e.context ? `<p class="meta">${lang === "ar" ? "سياق بيئي متزامن: " : "Same-time environmental context: "}${esc(e.context.map(mname).join(", "))}</p>` : ""}
      <p class="meta">z = ${e.maxZ}${e.absHit ? (lang === "ar" ? " · تجاوز حدًا ثابتًا" : " · fixed threshold exceeded") : ""}</p></article>`).join("")
      : `<p>${lang === "ar" ? "لا توجد إشارات غير معتادة." : "No unusual signals found."}</p>`;
    if (result.episodes.length > 30) A.insertAdjacentHTML("beforeend", `<p class="muted">+${result.episodes.length - 30} more (most recent shown)</p>`);
    const recent = result.episodes.filter(e => e.end >= result.cutoff), mset = new Set(recent.map(e => e.metric));
    const cards = Object.values(ADV).filter(a => a.metrics.some(m => mset.has(m)));
    const show = cards.length ? cards : Object.values(ADV);
    V.innerHTML = (cards.length ? "" : `<p class="muted">${lang === "ar" ? "لا توجد إشارات حديثة؛ هذه نصائح عامة." : "No recent signals; general advice shown."}</p>`) +
      show.map(a => { const geos = [...new Set(recent.filter(e => a.metrics.includes(e.metric)).map(e => e.geo))];
        return `<article class="adv"><h3>${esc(a.t[lang])}${geos.length ? " — " + esc(geos.join(", ")) : ""}</h3><ul>${a[lang].map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <p class="meta" lang="${lang === "ar" ? "en" : "ar"}" dir="${lang === "ar" ? "ltr" : "rtl"}">${esc((lang === "ar" ? a.en : a.ar)[0])}</p></article>`; }).join("");
    drawMap();
    $("#aiOut").textContent = "";
  }
  function drawMap() {
    if (!window.L) return;
    if (!map) {
      map = L.map("map", { scrollWheelZoom: false }).setView([27.5, 31], 5);
      // Basemap: bundled governorate boundaries (no third-party tile server, no key, works offline).
      // Optional raster tiles: set TILE_URL to a provider whose usage policy and key you have.
      const TILE_URL = "";
      if (TILE_URL) { let ok = 0, bad = 0;
        L.tileLayer(TILE_URL, { maxZoom: 12, attribution: "&copy; OpenStreetMap contributors" })
          .on("tileload", () => { ok++; $("#tileNote").hidden = true; })
          .on("tileerror", () => { bad++; if (!ok && bad >= 2) $("#tileNote").hidden = false; }).addTo(map); }
      map.attributionControl.addAttribution('Boundaries: <a href="https://www.geoboundaries.org">geoBoundaries</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)');
      fetch("egypt-governorates.geojson").then(r => r.json()).then(g => { geo = g; drawMap(); })
        .catch(() => { $("#tileNote").hidden = false; });
    }
    if (layer) layer.remove(); layer = L.layerGroup().addTo(map);
    if (geoLayer) geoLayer.remove();
    if (geo) geoLayer = L.geoJSON(geo, { interactive: false, style: f => { const r = result && result.risk[f.properties.name];
      return { color: "#5b6b7a", weight: 1, fillColor: r ? ["#dfe5ea","#f3d36b","#f0a35a","#e07b70"][r.level] : "#eef1f4", fillOpacity: r ? .75 : .5 }; } }).addTo(map).bringToBack();
    const tb = $("#riskTable tbody"); tb.innerHTML = "";
    if (!result) { if (geoLayer) map.fitBounds(geoLayer.getBounds()); return; }
    const col = ["#9aa5b1","#e3b505","#e07a00","#c0392b"], pts = [];
    Object.entries(result.risk).sort((a, b) => b[1].level - a[1].level).forEach(([g, r]) => {
      const ll = coords[g] || MS.GOV[g];
      tb.insertAdjacentHTML("beforeend", `<tr><td>${esc(g)}</td><td>${esc(LV[lang][r.level])}</td><td>${r.n}</td></tr>`);
      if (!ll) return; pts.push(ll);
      L.circleMarker(ll, { radius: 8 + r.level * 4, color: "#222", weight: 1, fillColor: col[r.level], fillOpacity: .8 })
        .bindPopup(`<b>${esc(g)}</b><br>${esc(LV[lang][r.level])} · ${r.n} ${lang === "ar" ? "تنبيه" : "alert(s)"}`).bindTooltip(g).addTo(layer);
    });
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 7 });
    setTimeout(() => map.invalidateSize(), 50);
  }
  async function readFiles(files) {
    for (const f of files) {
      try { if (f.size > 20e6) throw new Error(f.name + ": larger than 20 MB"); ingest(f.name, await f.text()); }
      catch (e) { status(e.message, true); return; }
    }
    run();
  }
  $("#files").addEventListener("change", e => readFiles([...e.target.files]));
  $("#loadSamples").addEventListener("click", async () => {
    status(lang === "ar" ? "جارٍ التحميل…" : "Loading SAMPLE data…");
    try { for (const n of ["SAMPLE_pharmacy_sales.csv","SAMPLE_environment.csv","SAMPLE_workplace.csv"]) ingest(n, await (await fetch("samples/" + n)).text()); run(); }
    catch (e) { status(e.message, true); }
  });
  $("#clear").addEventListener("click", () => { series = new Map(); coords = {}; loaded = []; result = null; $("#files").value = ""; status(""); render(); });
  $("#lang").addEventListener("click", () => { lang = lang === "en" ? "ar" : "en"; applyLang(); });
  // Optional LLM explanation: only shown if the server reports a key already configured.
  fetch("/api/explain").then(r => r.json()).then(j => { if (j.enabled) $("#aiBox").hidden = false; }).catch(() => {});
  $("#aiBtn").addEventListener("click", async () => {
    if (!result) return; const out = $("#aiOut"); out.textContent = "…";
    const summary = result.episodes.slice(0, 15).map(e => ({ geo: e.geo, metric: e.metric, start: e.start, end: e.end, days: e.days, z: e.maxZ, context: e.context || [] }));
    try { const r = await fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang, alerts: summary }) });
      const j = await r.json(); out.textContent = j.text || j.error || "No response"; } catch (e) { out.textContent = String(e); }
  });
  render();
})();
