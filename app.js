(() => {
  "use strict";

  const config = window.QUEUE_EXCHANGE_CONFIG || {};
  const parks = {
    disneyland: {
      name: "Disneyland",
      rides: [
        { name: "Star Wars: Rise of the Resistance", aliases: ["Star Wars Rise of the Resistance"], icon: "🛸" },
        { name: "Space Mountain", icon: "🚀" },
        { name: "Peter Pan's Flight", aliases: ["Peter Pan Flight"], icon: "🧚" },
        { name: "Mickey and Minnie's Runaway Railway", aliases: ["Mickey & Minnie's Runaway Railway", "Mickey and Minnies Runaway Railway"], icon: "🚂" },
        { name: "Pirates of the Caribbean", aliases: ["Pirates of Caribbean"], icon: "🏴‍☠️" },
        { name: "Buzz Lightyear Astro Blasters", icon: "👾" },
      ],
    },
    "california-adventure": {
      name: "California Adventure",
      rides: [
        { name: "Radiator Springs Racers", icon: "🏎️" },
        { name: "Incredicoaster", icon: "🎢" },
        { name: "The Little Mermaid - Ariel's Undersea Adventure", aliases: ["The Little Mermaid ~ Ariel's Undersea Adventure", "The Little Mermaid Ariel's Undersea Adventure", "The Little Mermaid - Ariels' Undersea Adventure"], icon: "🧜‍♀️" },
        { name: "Guardians of the Galaxy – Mission: BREAKOUT!", aliases: ["Guardians of the Galaxy - Mission: BREAKOUT!", "Guardians of the Galaxy Mission Breakout", "Guardians of the Galaxy – Mission Breakout"] },
      ],
    },
  };

  const colors = ["#f26f5b", "#2789bd", "#edaa28", "#9271d5", "#208e78", "#d85a91", "#6575d8", "#8cab3d", "#c45b3b", "#3f9db0"];
  const historyHours = 6;
  const pollMs = 60_000;
  const pageSize = 1000;
  const state = { cache: new Map(), busy: new Set(), visibleRides: new Set(), selectedRide: null };
  const $ = (id) => document.getElementById(id);

  function normalize(value) {
    return String(value).normalize("NFKD").replace(/[’‘]/g, "'").replace(/&/g, "and")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  }

  function matchRide(preference, rideNames) {
    const wanted = [preference.name, ...(preference.aliases || [])].map(normalize);
    return rideNames.find((name) => wanted.includes(normalize(name))) || null;
  }

  function supabaseUrl(table, params) {
    const base = String(config.supabaseUrl || "").replace(/\/$/, "");
    const url = new URL(`${base}/rest/v1/${table}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url;
  }

  async function fetchPage(table, params, start = 0, end = pageSize - 1) {
    const response = await fetch(supabaseUrl(table, params), {
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        Range: `${start}-${end}`,
        "Range-Unit": "items",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase returned ${response.status}: ${body.slice(0, 250)}`);
    }
    return response.json();
  }

  async function fetchAllPages(table, params) {
    const all = [];
    for (let start = 0; ; start += pageSize) {
      const page = await fetchPage(table, params, start, start + pageSize - 1);
      all.push(...page);
      if (page.length < pageSize) return all;
    }
  }

  function latestPerRide(rows) {
    const latest = new Map();
    for (const row of rows) {
      const previous = latest.get(row.ride_name);
      if (!previous || Date.parse(row.collected_at) > Date.parse(previous.collected_at)) latest.set(row.ride_name, row);
    }
    return latest;
  }

  function newestBestTimes(rows) {
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.attraction_name)) latest.set(row.attraction_name, row);
    return latest;
  }

  function initialState() { return { rides: [], observations: [], bestTimes: new Map(), reliability: new Map(), loadedAt: null }; }

  function allSeries() {
    return Object.keys(parks).flatMap((slug) => {
      const cache = state.cache.get(slug);
      if (!cache) return [];
      return cache.rides.filter((ride) => ride.sourceName).map(({ preference, sourceName }) => ({
        key: `${slug}::${sourceName}`, slug, parkName: parks[slug].name, preference, sourceName, cache,
      }));
    });
  }

  async function loadPark(slug) {
    const park = parks[slug];
    const cutoff = new Date(Date.now() - historyHours * 60 * 60 * 1000).toISOString();
    const [rideRows, bestRows, reliabilityRows] = await Promise.all([
      fetchAllPages("rides", { select: "ride_name", park_slug: `eq.${slug}`, order: "ride_name.asc" }),
      fetchAllPages("ride_best_times_snapshots", {
        select: "attraction_name,average_wait_minutes,peak_wait_minutes,quietest_hour,busiest_hour,samples,snapshot_date,retrieved_at",
        park_slug: `eq.${slug}`, order: "snapshot_date.desc,retrieved_at.desc",
      }),
      fetchAllPages("ride_reliability_summary", {
        select: "ride_name,availability_percent,grade,average_outage_minutes,outages,operating_days,retrieved_at",
        park_name: `eq.${park.name}`,
      }),
    ]);
    const matched = park.rides.map((preference) => ({ preference, sourceName: matchRide(preference, rideRows.map((row) => row.ride_name)) }));
    const names = matched.map((ride) => ride.sourceName).filter(Boolean);
    const bestTimes = newestBestTimes(bestRows);
    const reliability = new Map(reliabilityRows.map((row) => [normalize(row.ride_name), row]));
    let observations = [];
    if (names.length) {
      observations = await fetchAllPages("ride_wait_observations", {
        select: "poll_id,park_slug,ride_name,collected_at,wait_minutes,status",
        park_slug: `eq.${slug}`,
        ride_name: `in.(${names.map((name) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",")})`,
        collected_at: `gte.${cutoff}`,
        order: "collected_at.asc,ride_name.asc,poll_id.asc",
      });
    }
    const loaded = { rides: matched, observations, bestTimes, reliability, loadedAt: new Date().toISOString() };
    state.cache.set(slug, loaded);
    return loaded;
  }

  async function fetchNewObservations(slug, cache) {
    const names = cache.rides.map((ride) => ride.sourceName).filter(Boolean);
    if (!names.length) return;
    const lastTime = cache.observations.reduce((latest, row) => Math.max(latest, Date.parse(row.collected_at)), 0);
    const from = lastTime ? new Date(lastTime).toISOString() : new Date(Date.now() - historyHours * 60 * 60 * 1000).toISOString();
    const rows = await fetchAllPages("ride_wait_observations", {
      select: "poll_id,park_slug,ride_name,collected_at,wait_minutes,status",
      park_slug: `eq.${slug}`,
      ride_name: `in.(${names.map((name) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",")})`,
      collected_at: `gte.${from}`,
      order: "collected_at.asc,ride_name.asc,poll_id.asc",
    });
    const seen = new Set(cache.observations.map((row) => `${row.poll_id}:${row.ride_name}`));
    for (const row of rows) {
      const key = `${row.poll_id}:${row.ride_name}`;
      if (!seen.has(key)) { cache.observations.push(row); seen.add(key); }
    }
    const cutoff = Date.now() - historyHours * 60 * 60 * 1000;
    cache.observations = cache.observations.filter((row) => Date.parse(row.collected_at) >= cutoff);
  }

  function formatClock(iso) {
    if (!iso) return "No observations yet";
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }

  function updateFreshness() {
    const caches = [...state.cache.values()];
    const newestRows = caches.flatMap((cache) => cache.observations);
    const newest = newestRows.reduce((best, row) => !best || Date.parse(row.collected_at) > Date.parse(best) ? row.collected_at : best, null);
    const dot = $("fresh-dot");
    const label = $("fresh-label");
    $("last-updated").textContent = newest ? `Last collected ${formatClock(newest)}` : "No observation found yet";
    const ages = [...state.cache.values()].map((cache) => {
      const latest = cache.observations.reduce((best, row) => !best || Date.parse(row.collected_at) > Date.parse(best) ? row.collected_at : best, null);
      return latest ? Date.now() - Date.parse(latest) : Infinity;
    });
    const worstAge = ages.length === Object.keys(parks).length ? Math.max(...ages) : Infinity;
    dot.className = `fresh-dot${worstAge > 5 * 60_000 ? " offline" : worstAge > 150_000 ? " stale" : ""}`;
    label.textContent = worstAge <= 150_000 ? "Both park feeds are fresh" : worstAge <= 5 * 60_000 ? "One park feed is a little behind" : "Waiting for fresh data from both parks";
    const latestRows = caches.flatMap((cache) => [...latestPerRide(cache.observations).values()]);
    const latestTimestamp = newest ? new Date(newest).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    $("latest-wait").textContent = latestTimestamp;
    const active = latestRows.filter((row) => row.status.toUpperCase() === "OPERATING").length;
    const total = caches.reduce((count, cache) => count + cache.rides.filter((ride) => ride.sourceName).length, 0);
    $("rides-tracked").textContent = `${active}/${total || "—"}`;
  }

  function statusLabel(row) {
    if (!row) return { text: "No observation yet", state: "unknown" };
    const status = row.status.toUpperCase();
    if (status === "OPERATING") return { text: "Operating", state: "open" };
    if (status.includes("CLOSED") || status.includes("DOWN")) return { text: row.status.replaceAll("_", " ").toLowerCase(), state: "closed" };
    return { text: row.status.replaceAll("_", " ").toLowerCase(), state: "unknown" };
  }

  function number(value, digits = 0) {
    if (value === null || value === undefined || value === "") return "—";
    return Number(value).toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function renderRideList() {
    const container = $("ride-list");
    container.innerHTML = "";
    for (const slug of Object.keys(parks)) {
      const cache = state.cache.get(slug);
      if (!cache) continue;
      const group = document.createElement("section");
      group.className = "ride-group";
      const heading = document.createElement("h3");
      heading.className = "ride-group-label";
      heading.innerHTML = `<span class="park-code ${slug === "disneyland" ? "dl" : "dca"}">${slug === "disneyland" ? "DL" : "DCA"}</span>${escapeHtml(parks[slug].name)}`;
      group.appendChild(heading);
      const latest = latestPerRide(cache.observations);
      cache.rides.forEach(({ preference, sourceName }) => {
        const row = sourceName ? latest.get(sourceName) : null;
        const baseline = sourceName ? cache.bestTimes.get(sourceName) : null;
        const reliability = sourceName ? cache.reliability.get(normalize(sourceName)) : null;
        const status = statusLabel(row);
        const item = document.createElement("div");
        const isSelected = sourceName && state.selectedRide?.slug === slug && state.selectedRide?.rideName === sourceName;
        item.className = `ride-row${sourceName ? "" : " not-found"}${isSelected ? " is-selected" : ""}`;
        if (sourceName) {
          item.dataset.series = `${slug}::${sourceName}`;
          item.tabIndex = 0;
          item.setAttribute("role", "button");
          item.setAttribute("aria-expanded", String(Boolean(isSelected)));
        }
        const wait = row?.wait_minutes === null || row?.wait_minutes === undefined ? "—" : `${number(row.wait_minutes)}m`;
        const baselineText = baseline ? `${number(baseline.average_wait_minutes, 0)}m avg` : "No baseline yet";
        const reliabilityText = reliability ? ` · ${number(reliability.availability_percent, 0)}% reliable` : "";
        item.innerHTML = `<span class="ride-icon">${preference.icon || "✨"}</span><div class="ride-main"><span class="ride-name" title="${escapeHtml(sourceName || preference.name)}">${escapeHtml(preference.name)}</span><span class="ride-meta"><i class="ride-state-dot ${status.state}"></i>${escapeHtml(sourceName ? status.text : "Not found in this park's feed")}${sourceName ? ` · ${baselineText}${reliabilityText}` : ""}</span></div><div class="ride-current">${sourceName ? wait : "—"}<small>${sourceName && row?.wait_minutes != null ? "CURRENT WAIT" : "WAIT"}</small></div>`;
        if (sourceName) {
          item.addEventListener("click", () => showRideDetail(slug, sourceName));
          item.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              showRideDetail(slug, sourceName);
            }
          });
        }
        group.appendChild(item);
      });
      container.appendChild(group);
    }
    renderRideDetail();
  }

  function showRideDetail(slug, rideName) {
    state.selectedRide = { slug, rideName };
    renderRideList();
  }

  function renderRideDetail() {
    const panel = $("ride-detail");
    const selected = state.selectedRide;
    if (!selected) { panel.hidden = true; panel.innerHTML = ""; return; }
    const { slug, rideName } = selected;
    const cache = state.cache.get(slug);
    if (!cache) { panel.hidden = true; return; }
    const preference = cache.rides.find((ride) => ride.sourceName === rideName)?.preference;
    const latest = latestPerRide(cache.observations).get(rideName);
    const baseline = cache.bestTimes.get(rideName);
    const reliability = cache.reliability.get(normalize(rideName));
    const status = statusLabel(latest);
    const currentWait = latest?.wait_minutes == null ? "No wait posted" : `${number(latest.wait_minutes)} min`;
    const stat = (label, value) => `<div class="detail-stat"><span>${label}</span><strong>${value}</strong></div>`;
    panel.innerHTML = `<div class="detail-heading"><div><p class="eyebrow">RIDE DETAILS</p><h4>${escapeHtml(preference?.name || rideName)}</h4></div><button class="detail-close" type="button" aria-label="Close ride details">×</button></div><div class="detail-hero"><span>${preference?.icon || "🎢"}</span><div><small>RIGHT NOW</small><strong>${currentWait}</strong><em class="detail-status ${status.state}">${escapeHtml(status.text)}</em></div></div><div class="detail-stats">${stat("HISTORICAL AVG", baseline ? `${number(baseline.average_wait_minutes, 0)} min` : "—")}${stat("RECENT PEAK", baseline ? `${number(baseline.peak_wait_minutes, 0)} min` : "—")}${stat("RELIABILITY", reliability ? `${number(reliability.availability_percent, 0)}%` : "—")}${stat("AVG. OUTAGE", reliability ? `${number(reliability.average_outage_minutes, 0)} min` : "—")}</div><div class="detail-hours"><span>QUIETEST <b>${escapeHtml(baseline?.quietest_hour || "—")}</b></span><span>BUSIEST <b>${escapeHtml(baseline?.busiest_hour || "—")}</b></span></div><p class="detail-footnote">${baseline ? `Best-times snapshot ${escapeHtml(baseline.snapshot_date)} · ${number(baseline.samples)} samples` : "No best-times snapshot is available yet."}${reliability ? ` · ${number(reliability.outages)} outages across ${number(reliability.operating_days)} operating days` : ""}</p><div class="trade-panel" id="trade-panel"></div>`;
    panel.hidden = false;
    panel.querySelector(".detail-close").addEventListener("click", () => { state.selectedRide = null; renderRideList(); });
    window.dispatchEvent(new CustomEvent("queue:ride-selected", { detail: {
      slug, rideName, status: latest?.status ?? "UNKNOWN", waitMinutes: latest?.wait_minutes ?? null,
      collectedAt: latest?.collected_at ?? null,
    } }));
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function drawChart() {
    const canvas = $("combined-chart");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;
    const pad = { top: 13, right: 12, bottom: 30, left: 43 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const now = Date.now();
    const minX = now - historyHours * 60 * 60 * 1000;
    const maxX = now;
    const series = allSeries();
    const rowsBySeries = new Map(series.map((ride) => [ride.key, ride.cache.observations.filter((row) => row.ride_name === ride.sourceName && row.wait_minutes !== null)]));
    const maxWait = Math.max(60, ...[...rowsBySeries.values()].flat().map((row) => Number(row.wait_minutes)));
    const yMax = Math.ceil(maxWait / 30) * 30;
    const x = (time) => pad.left + ((time - minX) / (maxX - minX)) * plotW;
    const y = (wait) => pad.top + plotH - (wait / yMax) * plotH;

    ctx.clearRect(0, 0, width, height);
    ctx.font = "9px 'DM Mono', monospace";
    ctx.textBaseline = "middle";
    for (let value = 0; value <= yMax; value += Math.max(15, Math.ceil(yMax / 4 / 15) * 15)) {
      const py = y(value);
      ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(width - pad.right, py);
      ctx.strokeStyle = "#e9e7df"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#929a92"; ctx.textAlign = "right"; ctx.fillText(String(value), pad.left - 9, py);
    }
    for (let step = 0; step <= 6; step += 1) {
      const t = minX + step * 60 * 60 * 1000;
      const px = x(t);
      ctx.beginPath(); ctx.moveTo(px, pad.top); ctx.lineTo(px, pad.top + plotH);
      ctx.strokeStyle = "#f0eee7"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#929a92"; ctx.textAlign = step === 0 ? "left" : step === 6 ? "right" : "center";
      ctx.fillText(new Date(t).toLocaleTimeString([], { hour: "numeric" }), px, height - 12);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(pad.left, pad.top, plotW, plotH); ctx.clip();
    series.forEach((ride, index) => {
      if (!state.visibleRides.has(ride.key)) return;
      const points = rowsBySeries.get(ride.key).filter((row) => Date.parse(row.collected_at) >= minX && Date.parse(row.collected_at) <= maxX);
      if (!points.length) return;
      ctx.beginPath();
      points.forEach((row, pointIndex) => {
        const px = x(Date.parse(row.collected_at));
        const py = y(Number(row.wait_minutes));
        if (pointIndex === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = colors[index % colors.length]; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
      points.forEach((row) => {
        ctx.beginPath(); ctx.arc(x(Date.parse(row.collected_at)), y(Number(row.wait_minutes)), 1.35, 0, Math.PI * 2);
        ctx.fillStyle = colors[index % colors.length]; ctx.fill();
      });
    });
    ctx.restore();
    canvas._chartLayout = { pad, plotW, plotH, minX, maxX, yMax, series, rowsBySeries, x, y };
  }

  function renderLegend() {
    const legend = $("combined-legend");
    legend.innerHTML = "";
    allSeries().forEach((ride, index) => {
      if (!state.visibleRides.has(ride.key)) state.visibleRides.add(ride.key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `legend-item${state.visibleRides.has(ride.key) ? "" : " is-hidden"}`;
      button.title = `${ride.parkName} · ${ride.preference.name}`;
      button.innerHTML = `<span class="legend-dot" style="background:${colors[index % colors.length]}"></span><span class="legend-park">${ride.slug === "disneyland" ? "DL" : "DCA"}</span>${escapeHtml(ride.preference.name)}`;
      button.addEventListener("click", () => toggleRide(ride.key));
      legend.appendChild(button);
    });
  }

  function toggleRide(key) {
    if (state.visibleRides.has(key)) state.visibleRides.delete(key); else state.visibleRides.add(key);
    renderLegend();
    drawChart();
  }

  function handleChartMove(event) {
    const canvas = event.currentTarget;
    const layout = canvas._chartLayout;
    const tooltip = $("combined-tooltip");
    if (!layout) return;
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const chartX = Math.max(0, Math.min(layout.plotW, mx - layout.pad.left));
    const targetTime = layout.minX + (chartX / layout.plotW) * (layout.maxX - layout.minX);
    let best = null;
    for (let index = 0; index < layout.series.length; index += 1) {
      const ride = layout.series[index];
      if (!state.visibleRides.has(ride.key)) continue;
      for (const row of layout.rowsBySeries.get(ride.key)) {
        const dx = Math.abs(Date.parse(row.collected_at) - targetTime) / (layout.maxX - layout.minX) * layout.plotW;
        const dy = Math.abs(layout.y(Number(row.wait_minutes)) - my);
        const distance = Math.hypot(dx, dy);
        if (distance < 18 && (!best || distance < best.distance)) best = { ride, row, index, distance };
      }
    }
    if (!best) { tooltip.hidden = true; return; }
    tooltip.innerHTML = `<strong style="color:${colors[best.index % colors.length]}">${best.ride.slug === "disneyland" ? "DL" : "DCA"} · ${escapeHtml(best.ride.preference.name)}</strong>${number(best.row.wait_minutes)} min · ${formatClock(best.row.collected_at)}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(4, Math.min(rect.width - 165, mx + 12))}px`;
    tooltip.style.top = `${Math.max(2, my - 43)}px`;
  }

  function render() {
    renderRideList();
    renderLegend();
    drawChart();
    updateFreshness();
  }

  function showError(error) {
    const box = $("page-error");
    box.hidden = false;
    const message = String(error?.message || error);
    if (message.includes("YOUR_PROJECT_REF") || message.includes("YOUR_SUPABASE_PUBLISHABLE")) {
      box.textContent = "Add your Supabase project URL and publishable/anon key in docs/config.js, then reload. Use the public key only; the database's Row Level Security policies allow this page to read data.";
    } else {
      box.textContent = `Couldn't load the ride data. ${message}`;
    }
    $("fresh-dot").className = "fresh-dot offline";
    $("fresh-label").textContent = "Data connection needs attention";
  }

  async function refreshPark(slug) {
    if (state.busy.has(slug)) return null;
    state.busy.add(slug);
    try {
      const cache = state.cache.get(slug);
      if (!cache) await loadPark(slug);
      else await fetchNewObservations(slug, cache);
      return null;
    } catch (error) { return `${parks[slug].name}: ${error?.message || error}`; }
    finally { state.busy.delete(slug); }
  }

  async function refreshAll() {
    const errors = (await Promise.all(Object.keys(parks).map(refreshPark))).filter(Boolean);
    if (errors.length) showError(new Error(errors.join(" · ")));
    else $("page-error").hidden = true;
    render();
  }

  function init() {
    if (!config.supabaseUrl || !config.supabaseAnonKey || config.supabaseUrl.includes("YOUR_PROJECT_REF") || config.supabaseAnonKey.includes("YOUR_SUPABASE_")) {
      showError(new Error("YOUR_PROJECT_REF or YOUR_SUPABASE_PUBLISHABLE placeholder"));
      return;
    }
    const canvas = $("combined-chart");
    canvas.addEventListener("mousemove", handleChartMove);
    canvas.addEventListener("mouseleave", () => { $("combined-tooltip").hidden = true; });
    window.addEventListener("resize", () => {
      drawChart();
    });
    refreshAll();
    window.setInterval(refreshAll, pollMs);
  }

  init();
})();
