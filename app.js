const TABLES = {
  species: "piegeage_species",
  campaigns: "piegeage_campaigns",
  campaignSpecies: "piegeage_campaign_species",
  parcels: "piegeage_parcels",
  campaignParcels: "piegeage_campaign_parcels",
  traps: "piegeage_traps",
  trapEvents: "piegeage_trap_events",
  observations: "piegeage_observations_v2",
  details: "piegeage_observation_details",
  interventions: "piegeage_interventions",
  interventionParcels: "piegeage_intervention_parcels"
};

const SYNC_PRIORITY = [
  TABLES.species,
  TABLES.campaigns,
  TABLES.parcels,
  TABLES.campaignSpecies,
  TABLES.campaignParcels,
  TABLES.traps,
  TABLES.trapEvents,
  TABLES.observations,
  TABLES.details,
  TABLES.interventions,
  TABLES.interventionParcels
];

const INSTALL_STORAGE_KEY = "samPiegeageV2Installed";
const OFFLINE_DB_NAME = "sam-piegeage-v2";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_CACHE_STORE = "cache";
const OFFLINE_QUEUE_STORE = "queue";

let db;
let currentUser = null;
let chart = null;
let deferredInstallPrompt = null;
let syncInProgress = false;

const data = {
  species: [], campaigns: [], campaignSpecies: [], parcels: [], campaignParcels: [],
  traps: [], trapEvents: [], observations: [], details: [], interventions: [], interventionParcels: []
};

const $ = id => document.getElementById(id);
const uuid = () => crypto.randomUUID();
const todayISO = () => new Date().toISOString().slice(0, 10);

function setMessage(el, message = "", error = false) {
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR");
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function fmtNumber(value, digits = 1) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(Number(value || 0));
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function configReady() {
  const c = window.SAM_CONFIG || {};
  return Boolean(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
}

function isNetworkError(error) {
  if (!navigator.onLine) return true;
  return /failed to fetch|network|load failed|fetch failed|networkerror/i.test(String(error?.message || error || ""));
}

// -----------------------------------------------------------------------------
// IndexedDB : cache + file de synchronisation générique
// -----------------------------------------------------------------------------
function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OFFLINE_CACHE_STORE)) {
        database.createObjectStore(OFFLINE_CACHE_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
        database.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGetAll(storeName) {
  const database = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const database = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const database = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveCache() {
  try {
    await idbPut(OFFLINE_CACHE_STORE, {
      key: "dataset",
      saved_at: new Date().toISOString(),
      data: JSON.parse(JSON.stringify(data))
    });
  } catch (error) {
    console.warn("Cache local non enregistré", error);
  }
}

async function loadCache() {
  try {
    const rows = await idbGetAll(OFFLINE_CACHE_STORE);
    const cache = rows.find(row => row.key === "dataset");
    if (!cache?.data) return false;
    Object.keys(data).forEach(key => { data[key] = cache.data[key] || []; });
    return true;
  } catch (error) {
    console.warn("Cache local indisponible", error);
    return false;
  }
}

async function queueRecord(table, payload) {
  const key = `${table}:${payload.id}`;
  await idbPut(OFFLINE_QUEUE_STORE, { key, table, payload, saved_at: new Date().toISOString() });
  updateSyncStatus();
}

async function pendingQueue() {
  try { return await idbGetAll(OFFLINE_QUEUE_STORE); }
  catch { return []; }
}

function keyForTable(table) {
  return Object.entries(TABLES).find(([, value]) => value === table)?.[0];
}

function applyLocal(table, payload) {
  const key = keyForTable(table);
  if (!key) return;
  const list = data[key];
  const index = list.findIndex(row => row.id === payload.id);
  if (index >= 0) list[index] = { ...list[index], ...payload, _pending: !navigator.onLine };
  else list.push({ ...payload, _pending: !navigator.onLine });
}

function cleanPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith("_")));
}

async function writeRecord(table, payload, options = {}) {
  payload = cleanPayload(payload);
  applyLocal(table, payload);
  await saveCache();

  if (!currentUser) throw new Error("Connexion administrateur requise.");

  if (navigator.onLine) {
    const { data: saved, error } = await db.from(table).upsert(payload, { onConflict: "id" }).select().maybeSingle();
    if (!error) {
      if (saved) applyLocal(table, { ...saved, _pending: false });
      await idbDelete(OFFLINE_QUEUE_STORE, `${table}:${payload.id}`).catch(() => {});
      await saveCache();
      return saved || payload;
    }
    if (!isNetworkError(error)) {
      if (!options.silent) throw error;
      console.warn(error);
      return payload;
    }
  }

  await queueRecord(table, payload);
  return payload;
}

async function syncQueue() {
  if (syncInProgress || !navigator.onLine || !currentUser) return;
  const queue = await pendingQueue();
  if (!queue.length) { updateSyncStatus(); return; }

  syncInProgress = true;
  updateSyncStatus(`Synchronisation de ${queue.length} élément${queue.length > 1 ? "s" : ""}…`, "syncing");
  const sorted = queue.slice().sort((a, b) => SYNC_PRIORITY.indexOf(a.table) - SYNC_PRIORITY.indexOf(b.table));
  let done = 0;

  for (const item of sorted) {
    const { error } = await db.from(item.table).upsert(item.payload, { onConflict: "id" });
    if (!error) {
      await idbDelete(OFFLINE_QUEUE_STORE, item.key);
      done++;
      continue;
    }
    if (isNetworkError(error)) break;
    console.warn("Synchronisation impossible", item.table, error);
  }

  syncInProgress = false;
  if (done) {
    updateSyncStatus(`${done} élément${done > 1 ? "s" : ""} synchronisé${done > 1 ? "s" : ""}`, "success");
    await loadData(true);
    setTimeout(() => updateSyncStatus(), 3500);
  } else updateSyncStatus();
}

async function updateSyncStatus(message = null, mode = null) {
  const box = $("syncStatus");
  if (!box) return;
  box.classList.remove("hidden", "offline", "syncing", "success");

  if (message) {
    box.textContent = message;
    if (mode) box.classList.add(mode);
    return;
  }

  const queue = await pendingQueue();
  if (!navigator.onLine) {
    box.textContent = queue.length ? `Hors connexion — ${queue.length} élément${queue.length > 1 ? "s" : ""} en attente` : "Hors connexion";
    box.classList.add("offline");
  } else if (queue.length) {
    box.textContent = `${queue.length} élément${queue.length > 1 ? "s" : ""} en attente de synchronisation`;
    box.classList.add("syncing");
  } else box.classList.add("hidden");
}

// -----------------------------------------------------------------------------
// Supabase / authentification
// -----------------------------------------------------------------------------
async function init() {
  if (!configReady()) {
    setMessage($("globalMessage"), "Configuration Supabase absente dans config.js.", true);
    return;
  }
  db = window.supabase.createClient(window.SAM_CONFIG.SUPABASE_URL, window.SAM_CONFIG.SUPABASE_ANON_KEY);
  const { data: { session } } = await db.auth.getSession();
  currentUser = session?.user || null;
  renderAuth();

  db.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    renderAuth();
    await loadData();
    if (currentUser) await syncQueue();
  });

  await loadData();
  if (currentUser) await syncQueue();
}

function renderAuth() {
  const connected = Boolean(currentUser);
  $("loginForm").classList.toggle("hidden", connected);
  $("connectedBlock").classList.toggle("hidden", !connected);
  $("adminActions").classList.toggle("hidden", !connected);
  $("connectedEmail").textContent = currentUser?.email || "";
  if (!connected) $("loginPassword").value = "";
}

async function login(event) {
  event.preventDefault();
  setMessage($("loginMessage"));
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const button = $("loginForm").querySelector("button");
  button.disabled = true;
  const { error } = await db.auth.signInWithPassword({ email, password });
  button.disabled = false;
  if (error) return setMessage($("loginMessage"), "Connexion impossible. Vérifiez l’adresse mail et le mot de passe.", true);
  $("loginEmail").value = ""; $("loginPassword").value = ""; closeMobileAuthCard();
}

async function logout() { await db.auth.signOut(); closeMobileAuthCard(); }

async function fetchTable(table) {
  return await db.from(table).select("*");
}

async function loadData(silent = false) {
  if (!db) return;
  if (!silent) setMessage($("globalMessage"), "Chargement…");

  if (!navigator.onLine) {
    const cached = await loadCache();
    if (!cached) setMessage($("globalMessage"), "Aucune donnée locale disponible. Ouvre l’application une première fois avec Internet.", true);
    else { setMessage($("globalMessage")); renderAll(); }
    updateSyncStatus();
    return;
  }

  const entries = Object.entries(TABLES);
  const results = await Promise.all(entries.map(([, table]) => fetchTable(table)));
  const firstError = results.find(r => r.error)?.error;

  if (firstError) {
    const cached = await loadCache();
    if (cached && isNetworkError(firstError)) {
      setMessage($("globalMessage")); renderAll(); updateSyncStatus(); return;
    }
    setMessage($("globalMessage"), `Chargement impossible : ${firstError.message}`, true);
    return;
  }

  entries.forEach(([key], index) => { data[key] = results[index].data || []; });
  await saveCache();
  setMessage($("globalMessage"));
  renderAll();
  updateSyncStatus();
}

// -----------------------------------------------------------------------------
// Sélecteurs / relations
// -----------------------------------------------------------------------------
function activeRows(list) { return list.filter(row => !row.archived_at); }
function campaignById(id) { return data.campaigns.find(row => row.id === id); }
function parcelById(id) { return data.parcels.find(row => row.id === id); }
function trapById(id) { return data.traps.find(row => row.id === id); }
function speciesById(id) { return data.species.find(row => row.id === id); }

function activeCampaigns() {
  return activeRows(data.campaigns).sort((a, b) => b.year - a.year || a.name.localeCompare(b.name, "fr"));
}

function campaignSpecies(campaignId) {
  const ids = data.campaignSpecies.filter(link => link.campaign_id === campaignId && link.active !== false).map(link => link.species_id);
  return data.species.filter(s => ids.includes(s.id) && s.active !== false && !s.archived_at).sort((a, b) => a.scientific_name.localeCompare(b.scientific_name, "fr"));
}

function parcelsForCampaign(campaignId) {
  const linked = new Set(data.campaignParcels.filter(link => link.campaign_id === campaignId).map(link => link.parcel_id));
  activeRows(data.traps).filter(t => t.campaign_id === campaignId).forEach(t => linked.add(t.parcel_id));
  return activeRows(data.parcels).filter(p => linked.has(p.id)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function trapsForCampaign(campaignId, parcelId = "all") {
  return activeRows(data.traps)
    .filter(t => t.campaign_id === campaignId && (parcelId === "all" || t.parcel_id === parcelId))
    .sort((a, b) => a.code.localeCompare(b.code, "fr"));
}

function fillSelect(select, options, selected = null) {
  if (!select) return;
  select.innerHTML = "";
  options.forEach(opt => select.add(new Option(opt.label, opt.value)));
  if (selected != null && options.some(o => String(o.value) === String(selected))) select.value = selected;
}

function populateMainFilters() {
  const campaignSelect = $("campaignFilter");
  const previousCampaign = campaignSelect.value;
  const campaigns = activeCampaigns();
  fillSelect(campaignSelect, campaigns.length ? campaigns.map(c => ({ value: c.id, label: `${c.year} — ${c.name}` })) : [{ value: "", label: "Aucune campagne" }], previousCampaign);
  if (!campaignSelect.value && campaigns[0]) campaignSelect.value = campaigns[0].id;
  populateParcelFilter();
}

function populateParcelFilter() {
  const campaignId = $("campaignFilter").value;
  const previous = $("parcelFilter").value;
  const parcels = parcelsForCampaign(campaignId);
  fillSelect($("parcelFilter"), [{ value: "all", label: "Toutes les parcelles" }, ...parcels.map(p => ({ value: p.id, label: `${p.name} — ${p.variety || ""}` }))], previous || "all");
  populateTrapFilter();
}

function populateTrapFilter() {
  const campaignId = $("campaignFilter").value;
  const parcelId = $("parcelFilter").value || "all";
  const previous = $("trapFilter").value;
  const traps = trapsForCampaign(campaignId, parcelId);
  fillSelect($("trapFilter"), [{ value: "all", label: "Tous les pièges" }, ...traps.map(t => ({ value: t.id, label: `${t.code}${parcelById(t.parcel_id) ? ` — ${parcelById(t.parcel_id).name}` : ""}` }))], previous || "all");
  populateSpeciesFilter();
}

function populateSpeciesFilter() {
  const campaign = campaignById($("campaignFilter").value);
  const previous = $("speciesFilter").value;
  const opts = [{ value: "total", label: "Total des captures" }];

  if (campaign?.protocol_type === "aphid") {
    campaignSpecies(campaign.id).forEach(s => opts.push({ value: s.id, label: s.scientific_name }));
  }

  fillSelect($("speciesFilter"), opts, previous || "total");

  // Le protocole avancé permet de filtrer M / F / indéterminés,
  // y compris lorsque "Total des captures" est sélectionné.
  const advanced = campaign?.protocol_type === "aphid";
  $("sexFilter").disabled = !advanced;
  if (!advanced) $("sexFilter").value = "all";

  renderDashboard();
}

function populateAdminSelects() {
  const campaigns = activeCampaigns();
  const campaignOpts = campaigns.map(c => ({ value: c.id, label: `${c.year} — ${c.name}` }));
  ["trapCampaign", "observationCampaign", "interventionCampaign"].forEach(id => fillSelect($(id), campaignOpts, $(id)?.value || $("campaignFilter").value));
  populateTrapParcelSelect();
  populateObservationParcelSelect();
  populateEventTrapSelect();
}

function populateTrapParcelSelect() {
  const campaignId = $("trapCampaign")?.value;
  const allParcels = activeRows(data.parcels).sort((a, b) => a.exploitation.localeCompare(b.exploitation, "fr") || a.name.localeCompare(b.name, "fr"));
  fillSelect($("trapParcel"), allParcels.map(p => ({ value: p.id, label: `${p.exploitation} — ${p.name} — ${p.variety || ""}` })), $("trapParcel")?.value);
}

function populateObservationParcelSelect(preferredParcel = null, preferredTrap = null) {
  const campaignId = $("observationCampaign")?.value;
  const parcels = parcelsForCampaign(campaignId);
  fillSelect($("observationParcel"), parcels.map(p => ({ value: p.id, label: `${p.name} — ${p.variety || ""}` })), preferredParcel || $("observationParcel")?.value);
  populateObservationTrapSelect(preferredTrap);
  renderObservationSpeciesRows();
}

function populateObservationTrapSelect(preferred = null) {
  const campaignId = $("observationCampaign")?.value;
  const parcelId = $("observationParcel")?.value;
  const traps = trapsForCampaign(campaignId, parcelId);
  fillSelect($("observationTrap"), traps.map(t => ({ value: t.id, label: t.code })), preferred || $("observationTrap")?.value);
}

function populateEventTrapSelect() {
  const campaignId = $("campaignFilter").value;
  const traps = trapsForCampaign(campaignId);
  fillSelect($("eventTrap"), traps.map(t => ({ value: t.id, label: `${parcelById(t.parcel_id)?.name || ""} — ${t.code}` })), $("eventTrap")?.value);
}

function renderAll() {
  populateMainFilters();
  populateAdminSelects();
  renderManagementLists();
  renderDashboard();
}

// -----------------------------------------------------------------------------
// Analyses
// -----------------------------------------------------------------------------
function selectedObservations() {
  const campaignId = $("campaignFilter").value;
  const parcelId = $("parcelFilter").value || "all";
  const trapId = $("trapFilter").value || "all";
  return activeRows(data.observations).filter(obs => {
    if (obs.campaign_id !== campaignId) return false;
    const trap = trapById(obs.trap_id);
    if (!trap || trap.archived_at) return false;
    if (parcelId !== "all" && trap.parcel_id !== parcelId) return false;
    if (trapId !== "all" && obs.trap_id !== trapId) return false;
    return true;
  }).sort((a, b) => a.observed_on.localeCompare(b.observed_on));
}

function detailsForObservation(obsId) { return data.details.filter(d => d.observation_id === obsId); }

function identifiedTotal(obsId) {
  return detailsForObservation(obsId).reduce((sum, d) => sum + Number(d.males || 0) + Number(d.females || 0) + Number(d.undetermined || 0), 0);
}

function observationValue(obs) {
  const speciesId = $("speciesFilter").value;
  const sex = $("sexFilter").value;

  if (speciesId === "total") {
    if (sex === "all") return Number(obs.total_captured || 0);

    const details = detailsForObservation(obs.id);
    if (sex === "male") return details.reduce((sum, detail) => sum + Number(detail.males || 0), 0);
    if (sex === "female") return details.reduce((sum, detail) => sum + Number(detail.females || 0), 0);
    if (sex === "undetermined") return details.reduce((sum, detail) => sum + Number(detail.undetermined || 0), 0);

    return Number(obs.total_captured || 0);
  }

  const detail = data.details.find(d => d.observation_id === obs.id && d.species_id === speciesId);
  if (!detail) return 0;
  if (sex === "male") return Number(detail.males || 0);
  if (sex === "female") return Number(detail.females || 0);
  if (sex === "undetermined") return Number(detail.undetermined || 0);
  return Number(detail.males || 0) + Number(detail.females || 0) + Number(detail.undetermined || 0);
}

function daysBetween(a, b) {
  const ms = new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`);
  return Math.max(1, Math.round(ms / 86400000));
}

function observationValueWithUnit(obs, allTrapObs) {
  const value = observationValue(obs);
  if ($("unitFilter").value !== "per_day") return value;
  const index = allTrapObs.findIndex(o => o.id === obs.id);
  const trap = trapById(obs.trap_id);
  const previousObservationDate = index > 0 ? allTrapObs[index - 1].observed_on : null;
  const resetEvents = activeRows(data.trapEvents)
    .filter(e => e.trap_id === obs.trap_id && ["installation", "replacement"].includes(e.event_type) && e.event_date <= obs.observed_on)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  const resetDate = resetEvents[0]?.event_date || trap?.installed_on || null;
  let previousDate = previousObservationDate || resetDate;
  if (resetDate && previousObservationDate && resetDate > previousObservationDate) previousDate = resetDate;
  if (!previousDate) return null;
  return value / daysBetween(previousDate, obs.observed_on);
}

function campaignAnchor(campaign, observations) {
  if (campaign?.start_date) return campaign.start_date;
  const dates = observations.map(o => o.observed_on).sort();
  return dates[0] || todayISO();
}

function bucketStart(date, anchor) {
  const d = new Date(`${date}T12:00:00`);
  const a = new Date(`${anchor}T12:00:00`);
  const diff = Math.floor((d - a) / 86400000);
  const offset = Math.floor(Math.max(0, diff) / 7) * 7;
  const out = new Date(a); out.setDate(out.getDate() + offset);
  return out.toISOString().slice(0, 10);
}

function seriesData() {
  const observations = selectedObservations();
  const campaign = campaignById($("campaignFilter").value);
  const processing = $("processingFilter").value;
  const unit = $("unitFilter").value;
  const anchor = campaignAnchor(campaign, observations);
  const trapIds = [...new Set(observations.map(o => o.trap_id))];
  const series = [];

  trapIds.forEach(trapId => {
    const trap = trapById(trapId);
    const parcel = parcelById(trap?.parcel_id);
    const trapObs = observations.filter(o => o.trap_id === trapId).sort((a, b) => a.observed_on.localeCompare(b.observed_on));
    let points = [];

    if (processing === "observed") {
      points = trapObs.map(obs => ({ date: obs.observed_on, value: observationValueWithUnit(obs, trapObs) }));
    } else {
      const groups = new Map();
      trapObs.forEach(obs => {
        const week = bucketStart(obs.observed_on, anchor);
        if (!groups.has(week)) groups.set(week, []);
        const v = observationValueWithUnit(obs, trapObs);
        if (v != null) groups.get(week).push(v);
      });
      const weeks = [...groups.keys()].sort();
      const weekly = weeks.map(week => {
        const values = groups.get(week);
        const value = unit === "per_day" ? values.reduce((a,b)=>a+b,0) / Math.max(1, values.length) : values.reduce((a,b)=>a+b,0);
        return { date: week, value };
      });
      if (processing === "weekly") points = weekly;
      else points = weekly.map((point, index) => ({ date: point.date, value: index === 0 ? point.value : (point.value + weekly[index - 1].value) / 2 }));
    }

    series.push({ trap, parcel, label: `${parcel?.name || "Parcelle"} — ${trap?.code || "Piège"}`, points });
  });

  return { campaign, observations, series, anchor };
}

function eventDateForProcessing(date, anchor) {
  return $("processingFilter").value === "observed" ? date : bucketStart(date, anchor);
}

const eventLinePlugin = {
  id: "samEvents",
  afterDatasetsDraw(chartInstance, _args, pluginOptions) {
    const events = pluginOptions?.events || [];
    const x = chartInstance.scales.x;
    const y = chartInstance.scales.y;
    if (!x || !y) return;
    const ctx = chartInstance.ctx;
    events.forEach(event => {
      const index = chartInstance.data.labels.indexOf(event.date);
      if (index < 0) return;
      const px = x.getPixelForValue(index);
      ctx.save();
      ctx.strokeStyle = "rgba(140,90,17,.75)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(px, y.top); ctx.lineTo(px, y.bottom); ctx.stroke();
      ctx.restore();
    });
  }
};
Chart.register(eventLinePlugin);

function renderDashboard() {
  if (!$("campaignFilter")) return;
  renderMetrics();
  renderChart();
  renderHistory();
}

function renderMetrics() {
  const observations = selectedObservations();
  if (!observations.length) {
    $("lastValue").textContent = "—"; $("lastDate").textContent = "Aucune donnée";
    $("seasonTotal").textContent = "—"; $("identificationValue").textContent = "—"; $("identificationText").textContent = "—";
    $("recordCount").textContent = "0"; $("recordPeriod").textContent = "—"; return;
  }
  const last = observations[observations.length - 1];
  const values = observations.map(o => observationValue(o));
  $("lastValue").textContent = fmtNumber(observationValue(last), 1);
  $("lastDate").textContent = fmtDate(last.observed_on);
  $("seasonTotal").textContent = fmtNumber(values.reduce((a,b)=>a+b,0), 1);
  $("seasonUnit").textContent = $("unitFilter").value === "per_day" ? "valeur brute cumulée — voir courbe/jour" : "captures";
  const totalCaptured = observations.reduce((sum, o) => sum + Number(o.total_captured || 0), 0);
  const identified = observations.reduce((sum, o) => sum + identifiedTotal(o.id), 0);
  const pct = totalCaptured ? Math.round(100 * identified / totalCaptured) : 0;
  $("identificationValue").textContent = campaignById($("campaignFilter").value)?.protocol_type === "aphid" ? `${pct} %` : "—";
  $("identificationText").textContent = campaignById($("campaignFilter").value)?.protocol_type === "aphid" ? `${identified} identifiés / ${totalCaptured}` : "Protocole simple";
  $("recordCount").textContent = observations.length;
  $("recordPeriod").textContent = `${fmtDate(observations[0].observed_on)} → ${fmtDate(last.observed_on)}`;
}

function renderChart() {
  const { campaign, series, anchor } = seriesData();
  const speciesId = $("speciesFilter").value;
  const speciesLabel = speciesId === "total" ? "Total des captures" : (speciesById(speciesId)?.scientific_name || "Espèce");
  const sexLabel = { all: "", male: " — Mâles", female: " — Femelles", undetermined: " — Indéterminés" }[$("sexFilter").value] || "";
  const unitLabel = $("unitFilter").value === "per_day" ? "captures / jour" : "captures";
  const processLabel = { observed: "valeurs observées", weekly: "total hebdomadaire", smoothed: "lissage moyenne semaine courante + précédente" }[$("processingFilter").value];
  $("chartTitle").textContent = `${speciesLabel}${sexLabel} — ${unitLabel} — ${processLabel}`;
  $("campaignSummary").textContent = campaign ? `${campaign.pest_label} · ${campaign.year} · protocole ${campaign.protocol_type === "aphid" ? "avancé" : "simple"}` : "";

  const labelsSet = new Set();
  series.forEach(s => s.points.forEach(p => labelsSet.add(p.date)));

  const selectedParcelId = $("parcelFilter").value || "all";
  const interventions = activeRows(data.interventions).filter(i => {
    if (i.campaign_id !== campaign?.id) return false;
    if (selectedParcelId === "all") return true;
    const links = data.interventionParcels.filter(l => l.intervention_id === i.id);
    return !links.length || links.some(l => l.parcel_id === selectedParcelId);
  });
  const relevantTrapIds = new Set(series.map(s => s.trap.id));
  const trapEvents = activeRows(data.trapEvents).filter(e => relevantTrapIds.has(e.trap_id));
  const events = [
    ...interventions.map(i => ({ date: i.intervention_date, label: `${i.intervention_type}${i.product ? ` — ${i.product}` : ""}` })),
    ...trapEvents.map(e => ({ date: eventDateForProcessing(e.event_date, anchor), label: `${e.event_type} — ${e.label || trapById(e.trap_id)?.code || "piège"}` }))
  ];
  events.forEach(e => labelsSet.add(e.date));
  const labels = [...labelsSet].sort();

  const datasets = series.map((s, index) => ({
    label: s.label,
    data: labels.map(date => s.points.find(p => p.date === date)?.value ?? null),
    borderWidth: 2,
    pointRadius: 3,
    tension: .2,
    spanGaps: true
  }));

  $("chartEmpty").classList.toggle("hidden", Boolean(datasets.length));
  if (chart) chart.destroy();
  chart = new Chart($("trapChart"), {
    type: "line",
    data: { labels: labels.map(fmtDate), datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { position: "bottom" }, samEvents: { events: events.map(e => ({ ...e, date: fmtDate(e.date) })) } },
      scales: { y: { beginAtZero: true, title: { display: true, text: unitLabel } }, x: { ticks: { maxRotation: 45, minRotation: 0 } } }
    }
  });

  const legend = $("eventLegend"); legend.innerHTML = "";
  const allEvents = [...interventions.map(i => ({ type: "Intervention", date: i.intervention_date, label: `${i.intervention_type}${i.product ? ` — ${i.product}` : ""}`, record: i, table: TABLES.interventions })), ...trapEvents.map(e => ({ type: "Piège", date: e.event_date, label: e.label || e.event_type, record: e, table: TABLES.trapEvents }))].sort((a,b)=>a.date.localeCompare(b.date));
  allEvents.forEach(event => {
    const chip = document.createElement("span"); chip.className = "event-chip"; chip.textContent = `${fmtDate(event.date)} · ${event.type} : ${event.label}`;
    if (currentUser) {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "event-archive-button"; btn.textContent = " ×"; btn.title = "Archiver";
      btn.style.cssText = "border:0;background:transparent;color:inherit;font-weight:900;padding:0 0 0 4px";
      btn.addEventListener("click", async () => {
        const confirmed = await showSamConfirmation({
          title: "Archiver cet événement ?",
          message: "L’événement sera déplacé dans les Archives et pourra être restauré plus tard.",
          confirmText: "Archiver",
          mode: "archive"
        });

        if (!confirmed) return;

        await archiveRecord(event.table, event.record, true);
        renderAll();
      });
      chip.appendChild(btn);
    }
    legend.appendChild(chip);
  });
}

function renderHistory() {
  const container = $("historyList"); container.innerHTML = "";
  const observations = selectedObservations().slice().sort((a,b)=>b.observed_on.localeCompare(a.observed_on) || String(b.created_at).localeCompare(String(a.created_at)));
  if (!observations.length) { container.innerHTML = '<div class="history-empty">Aucun relevé pour cette sélection.</div>'; return; }

  observations.forEach(obs => {
    const trap = trapById(obs.trap_id); const parcel = parcelById(trap?.parcel_id); const details = detailsForObservation(obs.id);
    const identified = identifiedTotal(obs.id); const remaining = Math.max(0, Number(obs.total_captured || 0) - identified);
    const card = document.createElement("article"); card.className = `history-card${obs._pending ? " pending" : ""}`;
    const main = document.createElement("div"); main.className = "history-main";
    main.innerHTML = `<strong>${fmtDate(obs.observed_on)} — ${parcel?.name || "—"} — ${trap?.code || "—"}</strong><div class="history-meta"><b>${obs.total_captured}</b> capturé${obs.total_captured > 1 ? "s" : ""}${campaignById(obs.campaign_id)?.protocol_type === "aphid" ? ` · ${identified} identifié${identified > 1 ? "s" : ""} · ${remaining} restant${remaining > 1 ? "s" : ""}` : ""}${obs.comment ? ` · ${escapeHtml(obs.comment)}` : ""}</div>`;
    if (details.length) {
      const detailWrap = document.createElement("div"); detailWrap.className = "history-details";
      details.filter(d => Number(d.males||0)+Number(d.females||0)+Number(d.undetermined||0)>0).forEach(d => {
        const s = speciesById(d.species_id); const pill = document.createElement("span"); pill.className = "detail-pill";
        pill.textContent = `${s?.scientific_name || "Espèce"} : ${Number(d.males||0)+Number(d.females||0)+Number(d.undetermined||0)} (${d.males||0} M / ${d.females||0} F / ${d.undetermined||0} I)`;
        detailWrap.appendChild(pill);
      });
      main.appendChild(detailWrap);
    }
    card.appendChild(main);
    if (currentUser) {
      const actions = document.createElement("div"); actions.className = "history-actions";
      const edit = button("Modifier", "small-button", () => openObservationDialog(obs));
      const archive = button("Archiver", "small-button danger", async () => {
        const confirmed = await showSamConfirmation({
          title: "Archiver ce relevé ?",
          message: "Le relevé sera déplacé dans les Archives et pourra être restauré plus tard.",
          confirmText: "Archiver",
          mode: "archive"
        });

        if (!confirmed) return;

        await archiveRecord(TABLES.observations, obs, true);
        renderAll();
      });
      actions.append(edit, archive); card.appendChild(actions);
    }
    container.appendChild(card);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}


function showSamConfirmation({
  title = "Confirmer l’action",
  message = "",
  confirmText = "Confirmer",
  mode = "danger"
} = {}) {
  const dialog = $("confirmDialog");
  const titleEl = $("confirmDialogTitle");
  const messageEl = $("confirmDialogMessage");
  const confirmButton = $("confirmDialogConfirm");
  const cancelButton = $("confirmDialogCancel");

  if (!dialog || !titleEl || !messageEl || !confirmButton || !cancelButton) {
    return Promise.resolve(false);
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmButton.textContent = confirmText;

  dialog.classList.toggle("archive-mode", mode === "archive");

  return new Promise(resolve => {
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;

      cancelButton.removeEventListener("click", onCancel);
      confirmButton.removeEventListener("click", onConfirm);
      dialog.removeEventListener("cancel", onNativeCancel);
      dialog.removeEventListener("close", onClose);

      if (dialog.open) dialog.close();
      resolve(result);
    };

    const onCancel = () => finish(false);
    const onConfirm = () => finish(true);
    const onNativeCancel = event => {
      event.preventDefault();
      finish(false);
    };
    const onClose = () => {
      if (!settled) finish(false);
    };

    cancelButton.addEventListener("click", onCancel);
    confirmButton.addEventListener("click", onConfirm);
    dialog.addEventListener("cancel", onNativeCancel);
    dialog.addEventListener("close", onClose);

    dialog.showModal();
    cancelButton.focus();
  });
}

function button(text, className, handler) {
  const b = document.createElement("button"); b.type = "button"; b.className = className; b.textContent = text; b.addEventListener("click", handler); return b;
}

// -----------------------------------------------------------------------------
// Gestion / archivage
// -----------------------------------------------------------------------------
async function archiveRecord(table, record, archived) {
  const payload = {
    ...record,
    archived_at: archived ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  if (table === TABLES.species) {
    payload.active = !archived;
  }

  delete payload._pending;
  await writeRecord(table, payload);
}

function renderManagementLists() {
  renderCampaignList(); renderParcelList(); renderTrapList(); renderSpeciesList();
}

function renderCampaignList() {
  const box = $("campaignManageList"); if (!box) return; box.innerHTML = "";
  data.campaigns.slice().sort((a,b)=>b.year-a.year || a.name.localeCompare(b.name,"fr")).forEach(c => {
    const item = managementItem(`${c.year} — ${c.name}`, `${c.pest_label} · ${c.protocol_type === "aphid" ? "protocole avancé" : "protocole simple"}`, c.archived_at);
    item.actions.append(button("Modifier", "small-button", () => openCampaignDialog(c)), button(c.archived_at ? "Restaurer" : "Archiver", `small-button ${c.archived_at ? "restore" : "danger"}`, async()=>{await archiveRecord(TABLES.campaigns,c,!c.archived_at);renderAll();}));
    box.appendChild(item.root);
  });
}

function renderParcelList() {
  const box = $("parcelManageList"); if (!box) return; box.innerHTML = "";
  data.parcels.slice().sort((a,b)=>a.exploitation.localeCompare(b.exploitation,"fr")||a.name.localeCompare(b.name,"fr")).forEach(p => {
    const item = managementItem(`${p.exploitation} — ${p.name}`, `${p.variety || ""} · ${fmtNumber(p.area_ha,2)} ha`, p.archived_at);
    item.actions.append(button("Modifier","small-button",()=>openParcelDialog(p)),button(p.archived_at?"Restaurer":"Archiver",`small-button ${p.archived_at?"restore":"danger"}`,async()=>{await archiveRecord(TABLES.parcels,p,!p.archived_at);renderAll();}));
    box.appendChild(item.root);
  });
}

function renderTrapList() {
  const box = $("trapManageList"); if (!box) return; box.innerHTML = "";
  data.traps.slice().sort((a,b)=>String(a.code).localeCompare(String(b.code),"fr")).forEach(t => {
    const p=parcelById(t.parcel_id), c=campaignById(t.campaign_id); const item=managementItem(`${p?.name||"—"} — ${t.code}`, `${c?.name||"—"} · ${t.trap_type||"Type non renseigné"}`,t.archived_at);
    item.actions.append(button("Modifier","small-button",()=>openTrapDialog(t)),button("Événement","small-button",()=>openTrapEventDialog(t)),button(t.archived_at?"Restaurer":"Archiver",`small-button ${t.archived_at?"restore":"danger"}`,async()=>{await archiveRecord(TABLES.traps,t,!t.archived_at);renderAll();})); box.appendChild(item.root);
  });
}

function renderSpeciesList() {
  const box = $("speciesManageList");
  if (!box) return;
  box.innerHTML = "";

  data.species
    .slice()
    .sort((a, b) => a.scientific_name.localeCompare(b.scientific_name, "fr"))
    .forEach(species => {
      const archived = Boolean(species.archived_at);
      const item = managementItem(species.scientific_name, species.common_name || "", archived);

      item.actions.append(
        button(
          archived ? "Restaurer" : "Archiver",
          `small-button ${archived ? "restore" : "danger"}`,
          async () => {
            await archiveRecord(TABLES.species, species, !archived);
            renderAll();
          }
        )
      );

      box.appendChild(item.root);
    });
}

function openArchivesDialog() {
  renderArchiveLists();
  $("archivesDialog").showModal();
}

async function permanentlyDeleteArchived(entityType, record, label) {
  if (!navigator.onLine) {
    alert("La suppression définitive nécessite une connexion internet.");
    return;
  }

  const confirmed = await showSamConfirmation({
    title: "Suppression définitive",
    message: `Supprimer définitivement ${label} ?\n\nCette action est irréversible et peut aussi supprimer les données qui en dépendent.`,
    confirmText: "Supprimer définitivement",
    mode: "danger"
  });

  if (!confirmed) return;

  const { error } = await db.rpc("sam_piegeage_delete_archived", {
    p_entity: entityType,
    p_id: record.id
  });

  if (error) {
    alert(`Suppression impossible : ${error.message}`);
    return;
  }

  await loadData(true);
  renderArchiveLists();
}

function appendArchiveActions(item, table, record, entityType, label) {
  item.actions.append(
    button("Restaurer", "small-button restore", async () => {
      await archiveRecord(table, record, false);
      renderAll();
      renderArchiveLists();
    }),
    button("Supprimer définitivement", "small-button danger", async () => {
      await permanentlyDeleteArchived(entityType, record, label);
    })
  );
}

function renderArchiveLists() {
  const campaignBox = $("archivedCampaignList");
  const parcelBox = $("archivedParcelList");
  const trapBox = $("archivedTrapList");
  const speciesBox = $("archivedSpeciesList");
  const obsBox = $("archivedObservationList");
  const intBox = $("archivedInterventionList");
  const eventBox = $("archivedTrapEventList");

  [campaignBox, parcelBox, trapBox, speciesBox, obsBox, intBox, eventBox].forEach(box => {
    if (box) box.innerHTML = "";
  });

  const archivedCampaigns = data.campaigns
    .filter(c => c.archived_at)
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name, "fr"));

  if (!archivedCampaigns.length) campaignBox.innerHTML = '<div class="history-empty">Aucune campagne archivée.</div>';
  archivedCampaigns.forEach(campaign => {
    const item = managementItem(
      `${campaign.year} — ${campaign.name}`,
      `${campaign.pest_label} · ${campaign.protocol_type === "aphid" ? "protocole avancé" : "protocole simple"}`,
      true
    );
    appendArchiveActions(item, TABLES.campaigns, campaign, "campaign", `la campagne « ${campaign.name} »`);
    campaignBox.appendChild(item.root);
  });

  const archivedParcels = data.parcels
    .filter(parcel => parcel.archived_at)
    .sort((a, b) => a.exploitation.localeCompare(b.exploitation, "fr") || a.name.localeCompare(b.name, "fr"));

  if (!archivedParcels.length) parcelBox.innerHTML = '<div class="history-empty">Aucune parcelle archivée.</div>';
  archivedParcels.forEach(parcel => {
    const item = managementItem(
      `${parcel.exploitation} — ${parcel.name}`,
      `${parcel.variety || ""} · ${fmtNumber(parcel.area_ha, 2)} ha`,
      true
    );
    appendArchiveActions(item, TABLES.parcels, parcel, "parcel", `la parcelle « ${parcel.name} »`);
    parcelBox.appendChild(item.root);
  });

  const archivedTraps = data.traps
    .filter(trap => trap.archived_at)
    .sort((a, b) => String(a.code).localeCompare(String(b.code), "fr"));

  if (!archivedTraps.length) trapBox.innerHTML = '<div class="history-empty">Aucun piège archivé.</div>';
  archivedTraps.forEach(trap => {
    const parcel = parcelById(trap.parcel_id);
    const campaign = campaignById(trap.campaign_id);
    const item = managementItem(
      `${parcel?.name || "—"} — ${trap.code}`,
      `${campaign?.name || "—"} · ${trap.trap_type || "Type non renseigné"}`,
      true
    );
    appendArchiveActions(item, TABLES.traps, trap, "trap", `le piège « ${trap.code} »`);
    trapBox.appendChild(item.root);
  });

  const archivedSpecies = data.species
    .filter(species => species.archived_at || species.active === false)
    .sort((a, b) => a.scientific_name.localeCompare(b.scientific_name, "fr"));

  if (!archivedSpecies.length) speciesBox.innerHTML = '<div class="history-empty">Aucune espèce archivée.</div>';
  archivedSpecies.forEach(species => {
    const item = managementItem(species.scientific_name, species.common_name || "", true);
    appendArchiveActions(item, TABLES.species, species, "species", `l’espèce « ${species.scientific_name} »`);
    speciesBox.appendChild(item.root);
  });

  const archivedObs = data.observations
    .filter(obs => obs.archived_at)
    .sort((a, b) => b.observed_on.localeCompare(a.observed_on));

  if (!archivedObs.length) obsBox.innerHTML = '<div class="history-empty">Aucun relevé archivé.</div>';
  archivedObs.forEach(obs => {
    const trap = trapById(obs.trap_id);
    const parcel = parcelById(trap?.parcel_id);
    const item = managementItem(
      `${fmtDate(obs.observed_on)} — ${parcel?.name || "—"} — ${trap?.code || "—"}`,
      `${obs.total_captured} captures`,
      true
    );
    appendArchiveActions(item, TABLES.observations, obs, "observation", `le relevé du ${fmtDate(obs.observed_on)}`);
    obsBox.appendChild(item.root);
  });

  const archivedInts = data.interventions
    .filter(intervention => intervention.archived_at)
    .sort((a, b) => b.intervention_date.localeCompare(a.intervention_date));

  if (!archivedInts.length) intBox.innerHTML = '<div class="history-empty">Aucune intervention archivée.</div>';
  archivedInts.forEach(intervention => {
    const item = managementItem(
      `${fmtDate(intervention.intervention_date)} — ${intervention.intervention_type}`,
      intervention.product || "",
      true
    );
    appendArchiveActions(item, TABLES.interventions, intervention, "intervention", `l’intervention du ${fmtDate(intervention.intervention_date)}`);
    intBox.appendChild(item.root);
  });

  const archivedEvents = data.trapEvents
    .filter(event => event.archived_at)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));

  if (!archivedEvents.length) eventBox.innerHTML = '<div class="history-empty">Aucun événement de piège archivé.</div>';
  archivedEvents.forEach(event => {
    const trap = trapById(event.trap_id);
    const item = managementItem(
      `${fmtDate(event.event_date)} — ${trap?.code || "—"}`,
      event.label || event.event_type,
      true
    );
    appendArchiveActions(item, TABLES.trapEvents, event, "trap_event", `l’événement du ${fmtDate(event.event_date)}`);
    eventBox.appendChild(item.root);
  });
}

function managementItem(title, subtitle, archived) {
  const root=document.createElement("div");root.className=`management-item${archived?" archived":""}`;const info=document.createElement("div");info.className="management-info";info.innerHTML=`<strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}${archived?" · ARCHIVÉ":""}</span>`;const actions=document.createElement("div");actions.className="management-actions";root.append(info,actions);return{root,actions};
}

// -----------------------------------------------------------------------------
// Campagnes
// -----------------------------------------------------------------------------
function renderCampaignSpeciesChoices(selectedIds = []) {
  const box=$("campaignSpeciesChoices");box.innerHTML="";
  data.species.filter(s=>s.active!==false && !s.archived_at).forEach(s=>{const label=document.createElement("label");label.className="checkbox-card";label.innerHTML=`<input type="checkbox" value="${s.id}" ${selectedIds.includes(s.id)?"checked":""}> <span><b>${escapeHtml(s.scientific_name)}</b>${s.common_name?`<br><small>${escapeHtml(s.common_name)}</small>`:""}</span>`;box.appendChild(label);});
}

function toggleCampaignSpeciesSection(){const aphid=$("campaignProtocol").value==="aphid";$("campaignSpeciesSection").classList.toggle("hidden",!aphid);if(aphid&&!$("campaignId").value&&!$("campaignSpeciesChoices").querySelector("input:checked"))$("campaignSpeciesChoices").querySelectorAll("input").forEach(input=>input.checked=true);}

function openCampaignDialog(campaign=null){$("campaignForm").reset();$("campaignId").value=campaign?.id||"";$("campaignName").value=campaign?.name||"";$("campaignYear").value=campaign?.year||new Date().getFullYear();$("campaignPest").value=campaign?.pest_label||"";$("campaignProtocol").value=campaign?.protocol_type||"simple";$("campaignStart").value=campaign?.start_date||"";$("campaignEnd").value=campaign?.end_date||"";const selected=campaign?data.campaignSpecies.filter(l=>l.campaign_id===campaign.id&&l.active!==false).map(l=>l.species_id):[];renderCampaignSpeciesChoices(selected);toggleCampaignSpeciesSection();setMessage($("campaignMessage"));renderCampaignList();$("campaignDialog").showModal();}

async function saveCampaign(event){event.preventDefault();const existing=campaignById($("campaignId").value);const id=existing?.id||uuid();const payload={id,name:$("campaignName").value.trim(),year:Number($("campaignYear").value),pest_label:$("campaignPest").value.trim(),protocol_type:$("campaignProtocol").value,start_date:$("campaignStart").value||null,end_date:$("campaignEnd").value||null,legacy_key:existing?.legacy_key||null,archived_at:existing?.archived_at||null,created_by:existing?.created_by||currentUser.id,created_at:existing?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()};
  try{await writeRecord(TABLES.campaigns,payload);if(payload.protocol_type==="aphid"){const selected=[...$("campaignSpeciesChoices").querySelectorAll('input:checked')].map(i=>i.value);for(const s of data.species){let link=data.campaignSpecies.find(l=>l.campaign_id===id&&l.species_id===s.id);if(link){await writeRecord(TABLES.campaignSpecies,{...link,active:selected.includes(s.id)});}else if(selected.includes(s.id)){await writeRecord(TABLES.campaignSpecies,{id:uuid(),campaign_id:id,species_id:s.id,active:true,created_at:new Date().toISOString()});}}}setMessage($("campaignMessage"),navigator.onLine?"Campagne enregistrée.":"Campagne enregistrée hors connexion.");renderAll();renderCampaignList();}catch(error){setMessage($("campaignMessage"),error.message||"Enregistrement impossible.",true);}}

// -----------------------------------------------------------------------------
// Parcelles
// -----------------------------------------------------------------------------
function openParcelDialog(parcel=null){$("parcelForm").reset();$("parcelId").value=parcel?.id||"";$("parcelFarm").value=parcel?.exploitation||"";$("parcelName").value=parcel?.name||"";$("parcelVariety").value=parcel?.variety||"";$("parcelArea").value=parcel?.area_ha??"";setMessage($("parcelMessage"));renderParcelList();$("parcelDialog").showModal();}
async function saveParcel(event){event.preventDefault();const existing=parcelById($("parcelId").value);const payload={id:existing?.id||uuid(),exploitation:$("parcelFarm").value.trim(),name:$("parcelName").value.trim(),variety:$("parcelVariety").value.trim(),area_ha:Number($("parcelArea").value),created_by:existing?.created_by||currentUser.id,created_at:existing?.created_at||new Date().toISOString(),archived_at:existing?.archived_at||null,updated_at:new Date().toISOString()};try{await writeRecord(TABLES.parcels,payload);setMessage($("parcelMessage"),navigator.onLine?"Parcelle enregistrée.":"Parcelle enregistrée hors connexion.");renderAll();renderParcelList();}catch(error){setMessage($("parcelMessage"),error.message||"Enregistrement impossible.",true);}}

// -----------------------------------------------------------------------------
// Pièges et événements
// -----------------------------------------------------------------------------
function openTrapDialog(trap=null){$("trapForm").reset();populateAdminSelects();$("trapId").value=trap?.id||"";$("trapCampaign").value=trap?.campaign_id||$("campaignFilter").value;populateTrapParcelSelect();$("trapParcel").value=trap?.parcel_id||"";$("trapCode").value=trap?.code||"";$("trapType").value=trap?.trap_type||"";$("trapRow").value=trap?.row_ref||"";$("trapPosition").value=trap?.position||"";$("trapInstalled").value=trap?.installed_on||todayISO();$("trapAttractant").value=trap?.attractant||"";$("trapComment").value=trap?.comment||"";setMessage($("trapMessage"));renderTrapList();$("trapDialog").showModal();}
async function saveTrap(event){event.preventDefault();const existing=data.traps.find(t=>t.id===$("trapId").value);const payload={id:existing?.id||uuid(),campaign_id:$("trapCampaign").value,parcel_id:$("trapParcel").value,code:$("trapCode").value.trim(),trap_type:$("trapType").value.trim()||null,row_ref:$("trapRow").value.trim()||null,position:$("trapPosition").value.trim()||null,installed_on:$("trapInstalled").value||null,removed_on:existing?.removed_on||null,attractant:$("trapAttractant").value.trim()||null,comment:$("trapComment").value.trim()||null,archived_at:existing?.archived_at||null,created_by:existing?.created_by||currentUser.id,created_at:existing?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()};try{await writeRecord(TABLES.traps,payload);let link=data.campaignParcels.find(l=>l.campaign_id===payload.campaign_id&&l.parcel_id===payload.parcel_id);if(!link)await writeRecord(TABLES.campaignParcels,{id:uuid(),campaign_id:payload.campaign_id,parcel_id:payload.parcel_id,modality:null,created_at:new Date().toISOString()});if(!existing&&payload.installed_on)await writeRecord(TABLES.trapEvents,{id:uuid(),trap_id:payload.id,event_date:payload.installed_on,event_type:"installation",label:"Installation du piège",comment:payload.comment,archived_at:null,created_by:currentUser.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});setMessage($("trapMessage"),navigator.onLine?"Piège enregistré.":"Piège enregistré hors connexion.");renderAll();renderTrapList();}catch(error){setMessage($("trapMessage"),error.message||"Enregistrement impossible.",true);}}
function openTrapEventDialog(trap=null){populateEventTrapSelect();if(trap)$("eventTrap").value=trap.id;$("eventDate").value=todayISO();$("eventType").value="replacement";$("eventLabel").value="";$("eventComment").value="";setMessage($("eventMessage"));$("trapEventDialog").showModal();}
async function saveTrapEvent(event){event.preventDefault();const payload={id:uuid(),trap_id:$("eventTrap").value,event_date:$("eventDate").value,event_type:$("eventType").value,label:$("eventLabel").value.trim()||null,comment:$("eventComment").value.trim()||null,archived_at:null,created_by:currentUser.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};try{await writeRecord(TABLES.trapEvents,payload);if(payload.event_type==="replacement"){const trap=trapById(payload.trap_id);if(trap)await writeRecord(TABLES.traps,{...trap,installed_on:payload.event_date,updated_at:new Date().toISOString()});}setMessage($("eventMessage"),navigator.onLine?"Événement enregistré.":"Événement enregistré hors connexion.");renderAll();}catch(error){setMessage($("eventMessage"),error.message||"Enregistrement impossible.",true);}}

// -----------------------------------------------------------------------------
// Relevés / identification
// -----------------------------------------------------------------------------
function renderObservationSpeciesRows(existingDetails=[]){const campaign=campaignById($("observationCampaign")?.value);const section=$("aphidDetailSection");const box=$("aphidSpeciesRows");if(!campaign||campaign.protocol_type!=="aphid"){section.classList.add("hidden");box.innerHTML="";return;}section.classList.remove("hidden");box.innerHTML="";campaignSpecies(campaign.id).forEach(s=>{const d=existingDetails.find(x=>x.species_id===s.id);const row=document.createElement("div");row.className="species-detail-row";row.dataset.speciesId=s.id;row.innerHTML=`<div class="species-name"><strong>${escapeHtml(s.scientific_name)}</strong><span>${escapeHtml(s.common_name||"")}</span></div><label>Mâles<input class="male-input" type="number" min="0" step="1" value="${d?.males||0}"></label><label>Femelles<input class="female-input" type="number" min="0" step="1" value="${d?.females||0}"></label><label>Indéterminés<input class="undetermined-input" type="number" min="0" step="1" value="${d?.undetermined||0}"></label>`;box.appendChild(row);});updateIdentificationSummary();}
function updateIdentificationSummary(){const rows=[...$("aphidSpeciesRows").querySelectorAll(".species-detail-row")];const identified=rows.reduce((sum,row)=>sum+Number(row.querySelector(".male-input").value||0)+Number(row.querySelector(".female-input").value||0)+Number(row.querySelector(".undetermined-input").value||0),0);const total=Number($("observationTotal").value||0);$("identificationSummary").textContent=`${identified} identifié${identified>1?"s":""} · ${Math.max(0,total-identified)} restant${Math.max(0,total-identified)>1?"s":""}`;$("identificationSummary").classList.toggle("over",identified>total);}
function openObservationDialog(obs=null){$("observationForm").reset();$("observationId").value=obs?.id||"";$("observationDialogTitle").textContent=obs?"Modifier / compléter le relevé":"Ajouter un relevé";populateAdminSelects();const campaignId=obs?.campaign_id||$("campaignFilter").value||activeCampaigns()[0]?.id;$("observationCampaign").value=campaignId||"";const trap=obs?trapById(obs.trap_id):null;populateObservationParcelSelect(trap?.parcel_id||($("parcelFilter").value!=="all"?$("parcelFilter").value:null),obs?.trap_id||($("trapFilter").value!=="all"?$("trapFilter").value:null));$("observationDate").value=obs?.observed_on||todayISO();$("observationTotal").value=obs?.total_captured??"";$("observationComment").value=obs?.comment||"";renderObservationSpeciesRows(obs?detailsForObservation(obs.id):[]);setMessage($("observationMessage"));$("observationDialog").showModal();}
async function saveObservation(event){event.preventDefault();const existing=data.observations.find(o=>o.id===$("observationId").value);const campaign=campaignById($("observationCampaign").value);const total=Number($("observationTotal").value);if(!campaign||!$("observationTrap").value||!Number.isInteger(total)||total<0)return setMessage($("observationMessage"),"Renseigne correctement la campagne, le piège, la date et le total.",true);const detailRows=[...$("aphidSpeciesRows").querySelectorAll(".species-detail-row")].map(row=>({species_id:row.dataset.speciesId,males:Number(row.querySelector(".male-input").value||0),females:Number(row.querySelector(".female-input").value||0),undetermined:Number(row.querySelector(".undetermined-input").value||0)}));const identified=detailRows.reduce((s,d)=>s+d.males+d.females+d.undetermined,0);if(campaign.protocol_type==="aphid"&&identified>total)return setMessage($("observationMessage"),`Impossible : ${identified} individus sont identifiés alors que le total capturé est ${total}.`,true);const status=campaign.protocol_type!=="aphid"?"not_applicable":identified===0?"not_started":identified<total?"partial":"complete";const payload={id:existing?.id||uuid(),campaign_id:campaign.id,trap_id:$("observationTrap").value,observed_on:$("observationDate").value,total_captured:total,identification_status:status,comment:$("observationComment").value.trim()||null,legacy_source_id:existing?.legacy_source_id||null,archived_at:existing?.archived_at||null,created_by:existing?.created_by||currentUser.id,created_at:existing?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()};try{await writeRecord(TABLES.observations,payload);if(campaign.protocol_type==="aphid"){for(const d of detailRows){const old=data.details.find(x=>x.observation_id===payload.id&&x.species_id===d.species_id);await writeRecord(TABLES.details,{id:old?.id||uuid(),observation_id:payload.id,species_id:d.species_id,males:d.males,females:d.females,undetermined:d.undetermined,created_at:old?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()});}}setMessage($("observationMessage"),navigator.onLine?"Relevé enregistré.":"Relevé enregistré hors connexion. Il sera synchronisé automatiquement.");$("campaignFilter").value=campaign.id;populateParcelFilter();renderAll();}catch(error){setMessage($("observationMessage"),error.message||"Enregistrement impossible.",true);}}

// -----------------------------------------------------------------------------
// Interventions
// -----------------------------------------------------------------------------
function renderInterventionParcelChoices(campaignId,selected=[]){const box=$("interventionParcelChoices");box.innerHTML="";parcelsForCampaign(campaignId).forEach(p=>{const label=document.createElement("label");label.className="checkbox-card";label.innerHTML=`<input type="checkbox" value="${p.id}" ${selected.includes(p.id)?"checked":""}> <span>${escapeHtml(p.name)} — ${escapeHtml(p.variety||"")}</span>`;box.appendChild(label);});}
function openInterventionDialog(){const campaignId=$("campaignFilter").value||activeCampaigns()[0]?.id;populateAdminSelects();$("interventionCampaign").value=campaignId||"";$("interventionDate").value=todayISO();$("interventionTime").value="";$("interventionType").value="Traitement";$("interventionProduct").value="";$("interventionDose").value="";$("interventionTarget").value="";$("interventionComment").value="";renderInterventionParcelChoices(campaignId,[]);setMessage($("interventionMessage"));$("interventionDialog").showModal();}
async function saveIntervention(event){event.preventDefault();const id=uuid();const payload={id,campaign_id:$("interventionCampaign").value,intervention_date:$("interventionDate").value,intervention_time:$("interventionTime").value||null,intervention_type:$("interventionType").value.trim(),product:$("interventionProduct").value.trim()||null,dose:$("interventionDose").value.trim()||null,target:$("interventionTarget").value.trim()||null,comment:$("interventionComment").value.trim()||null,archived_at:null,created_by:currentUser.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};try{await writeRecord(TABLES.interventions,payload);const parcels=[...$("interventionParcelChoices").querySelectorAll('input:checked')].map(i=>i.value);for(const parcelId of parcels)await writeRecord(TABLES.interventionParcels,{id:uuid(),intervention_id:id,parcel_id:parcelId,created_at:new Date().toISOString()});setMessage($("interventionMessage"),navigator.onLine?"Intervention enregistrée.":"Intervention enregistrée hors connexion.");renderAll();}catch(error){setMessage($("interventionMessage"),error.message||"Enregistrement impossible.",true);}}

// -----------------------------------------------------------------------------
// Espèces
// -----------------------------------------------------------------------------
function openSpeciesDialog(){renderSpeciesList();setMessage($("speciesMessage"));$("speciesDialog").showModal();}
async function saveSpecies(event){event.preventDefault();const scientific=$("speciesScientific").value.trim();const common=$("speciesCommon").value.trim();if(!scientific)return;const existing=data.species.find(s=>s.code===slugify(scientific));if(existing)return setMessage($("speciesMessage"),"Cette espèce existe déjà.",true);const payload={id:uuid(),code:slugify(scientific),scientific_name:scientific,common_name:common||null,active:true,created_by:currentUser.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};try{await writeRecord(TABLES.species,payload);$("speciesForm").reset();setMessage($("speciesMessage"),"Espèce ajoutée.");renderAll();renderSpeciesList();}catch(error){setMessage($("speciesMessage"),error.message||"Enregistrement impossible.",true);}}

// -----------------------------------------------------------------------------
// Export Excel — structure proche du classeur de Bertrand
// -----------------------------------------------------------------------------
function exportExcel() {
  if (!window.XLSX) return setMessage($("globalMessage"), "Bibliothèque d’export Excel indisponible.", true);
  const campaign = campaignById($("campaignFilter").value); if (!campaign) return;
  const traps = trapsForCampaign(campaign.id); const observations = activeRows(data.observations).filter(o=>o.campaign_id===campaign.id).sort((a,b)=>a.observed_on.localeCompare(b.observed_on));
  const dates=[...new Set(observations.map(o=>o.observed_on))].sort();
  const rows=[];
  rows.push([campaign.name]);
  rows.push(["Parcelle / piège","Mesure",...dates.map(fmtDate)]);

  traps.forEach(trap=>{
    const parcel=parcelById(trap.parcel_id);const trapObs=observations.filter(o=>o.trap_id===trap.id);
    const valueByDate=(date,fn)=>{const obs=trapObs.find(o=>o.observed_on===date);return obs?fn(obs):"";};
    rows.push([`${parcel?.name||""} (${parcel?.variety||""}) — ${trap.code}`,"Total",...dates.map(d=>valueByDate(d,o=>o.total_captured))]);
    if(campaign.protocol_type==="aphid")campaignSpecies(campaign.id).forEach(s=>{
      const detailVal=(obs,key)=>{const det=data.details.find(x=>x.observation_id===obs.id&&x.species_id===s.id);return det?Number(det[key]||0):"";};
      rows.push(["",`${s.scientific_name} — M`,...dates.map(d=>valueByDate(d,o=>detailVal(o,"males")))]);
      rows.push(["",`${s.scientific_name} — F`,...dates.map(d=>valueByDate(d,o=>detailVal(o,"females")))]);
      rows.push(["",`${s.scientific_name} — I`,...dates.map(d=>valueByDate(d,o=>detailVal(o,"undetermined")))]);
    });
    rows.push([]);
  });

  const anchor=campaignAnchor(campaign,observations);const weeks=[...new Set(observations.map(o=>bucketStart(o.observed_on,anchor)))].sort();
  rows.push([]);rows.push(["TOTAUX HEBDOMADAIRES ET LISSAGE"]);rows.push(["Parcelle / piège","Mesure",...weeks.map(w=>fmtDate(w))]);
  traps.forEach(trap=>{const parcel=parcelById(trap.parcel_id);const trapObs=observations.filter(o=>o.trap_id===trap.id);const totals=weeks.map(w=>trapObs.filter(o=>bucketStart(o.observed_on,anchor)===w).reduce((sum,o)=>sum+Number(o.total_captured||0),0));const smooth=totals.map((v,i)=>i===0?v:(v+totals[i-1])/2);rows.push([`${parcel?.name||""} — ${trap.code}`,"Total hebdomadaire",...totals]);rows.push(["","Total lissé",...smooth]);if(campaign.protocol_type==="aphid")campaignSpecies(campaign.id).forEach(s=>{const weekly=weeks.map(w=>trapObs.filter(o=>bucketStart(o.observed_on,anchor)===w).reduce((sum,o)=>{const d=data.details.find(x=>x.observation_id===o.id&&x.species_id===s.id);return sum+(d?Number(d.males||0)+Number(d.females||0)+Number(d.undetermined||0):0);},0));const sm=weekly.map((v,i)=>i===0?v:(v+weekly[i-1])/2);rows.push(["",s.scientific_name,...weekly]);rows.push(["",`${s.scientific_name} lissé`,...sm]);});rows.push([]);});

  const wb=XLSX.utils.book_new();const ws=XLSX.utils.aoa_to_sheet(rows);ws["!cols"]=[{wch:34},{wch:30},...dates.map(()=>({wch:12}))];XLSX.utils.book_append_sheet(wb,ws,(campaign.name||"Campagne").slice(0,31));
  const trapRows=[["Campagne","Parcelle","Variété","Piège","Type","Rang","Position","Installation","Attractif","Commentaire"],...traps.map(t=>{const p=parcelById(t.parcel_id);return[campaign.name,p?.name||"",p?.variety||"",t.code,t.trap_type||"",t.row_ref||"",t.position||"",t.installed_on||"",t.attractant||"",t.comment||""];})];XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(trapRows),"Pièges");
  const interventionRows=[["Date","Heure","Type","Produit","Dose","Cible","Parcelles","Commentaire"],...activeRows(data.interventions).filter(i=>i.campaign_id===campaign.id).map(i=>{const ids=data.interventionParcels.filter(l=>l.intervention_id===i.id).map(l=>l.parcel_id);return[i.intervention_date,i.intervention_time||"",i.intervention_type,i.product||"",i.dose||"",i.target||"",ids.map(id=>parcelById(id)?.name).filter(Boolean).join(", "),i.comment||""];})];XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(interventionRows),"Interventions");
  XLSX.writeFile(wb,`SAM_Piegeage_${slugify(campaign.name)}_${campaign.year}.xlsx`);
}

// -----------------------------------------------------------------------------
// Mobile / PWA
// -----------------------------------------------------------------------------
function toggleMobileAuthCard(){if(innerWidth>720)return;const card=$("authCard");const open=card.classList.toggle("open");$("authToggleButton").setAttribute("aria-expanded",String(open));}
function closeMobileAuthCard(){if(innerWidth>720)return;$("authCard").classList.remove("open");$("authToggleButton").setAttribute("aria-expanded","false");}
function isStandalone(){return matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;}
function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);}
function isMobile(){return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);}
function showInstallMessage(message){$("installMessage").textContent=message;$("installMessage").classList.remove("hidden");setTimeout(()=>$("installMessage").classList.add("hidden"),7000);}
async function installApp(){if(deferredInstallPrompt){deferredInstallPrompt.prompt();const result=await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;if(result.outcome==="accepted"){localStorage.setItem(INSTALL_STORAGE_KEY,"1");$("installCard").classList.add("hidden");}return;}if(isIOS())showInstallMessage("Sur iPhone/iPad : dans Safari, touche Partager puis « Sur l’écran d’accueil ». ");else showInstallMessage("Utilise le menu du navigateur puis « Installer l’application » ou « Ajouter à l’écran d’accueil ». ");}
function initPWA(){const card=$("installCard");if(isStandalone())localStorage.setItem(INSTALL_STORAGE_KEY,"1");card.classList.toggle("hidden",!isMobile()||isStandalone()||localStorage.getItem(INSTALL_STORAGE_KEY)==="1");addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstallPrompt=e;if(isMobile()&&!isStandalone())card.classList.remove("hidden");});addEventListener("appinstalled",()=>{localStorage.setItem(INSTALL_STORAGE_KEY,"1");card.classList.add("hidden");});if("serviceWorker"in navigator)addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js").catch(console.warn));}

// -----------------------------------------------------------------------------
// Événements UI
// -----------------------------------------------------------------------------
function bind() {
  $("loginForm").addEventListener("submit",login);$("logoutButton").addEventListener("click",logout);$("authToggleButton").addEventListener("click",toggleMobileAuthCard);$("installButton").addEventListener("click",installApp);
  $("campaignFilter").addEventListener("change",()=>{populateParcelFilter();populateAdminSelects();renderDashboard();});$("parcelFilter").addEventListener("change",()=>{populateTrapFilter();renderDashboard();});$("trapFilter").addEventListener("change",renderDashboard);$("speciesFilter").addEventListener("change",populateSpeciesFilter);$("sexFilter").addEventListener("change",renderDashboard);$("unitFilter").addEventListener("change",renderDashboard);$("processingFilter").addEventListener("change",renderDashboard);$("exportExcelButton").addEventListener("click",exportExcel);
  $("newCampaignButton").addEventListener("click",()=>openCampaignDialog());$("newParcelButton").addEventListener("click",()=>openParcelDialog());$("newTrapButton").addEventListener("click",()=>openTrapDialog());$("newObservationButton").addEventListener("click",()=>openObservationDialog());$("newInterventionButton").addEventListener("click",openInterventionDialog);$("speciesButton").addEventListener("click",openSpeciesDialog);$("archivesButton").addEventListener("click",openArchivesDialog);
  $("campaignForm").addEventListener("submit",saveCampaign);$("parcelForm").addEventListener("submit",saveParcel);$("trapForm").addEventListener("submit",saveTrap);$("trapEventForm").addEventListener("submit",saveTrapEvent);$("observationForm").addEventListener("submit",saveObservation);$("interventionForm").addEventListener("submit",saveIntervention);$("speciesForm").addEventListener("submit",saveSpecies);
  $("campaignProtocol").addEventListener("change",toggleCampaignSpeciesSection);$("trapCampaign").addEventListener("change",populateTrapParcelSelect);$("observationCampaign").addEventListener("change",()=>populateObservationParcelSelect());$("observationParcel").addEventListener("change",()=>populateObservationTrapSelect());$("observationTotal").addEventListener("input",updateIdentificationSummary);$("aphidSpeciesRows").addEventListener("input",updateIdentificationSummary);$("interventionCampaign").addEventListener("change",()=>renderInterventionParcelChoices($("interventionCampaign").value,[]));
  document.querySelectorAll("[data-close]").forEach(btn=>btn.addEventListener("click",()=>$(btn.dataset.close).close()));document.querySelectorAll("dialog").forEach(dialog=>dialog.addEventListener("click",event=>{if(event.target===dialog)dialog.close();}));
  addEventListener("offline",updateSyncStatus);addEventListener("online",async()=>{updateSyncStatus("Connexion retrouvée — synchronisation…","syncing");await syncQueue();});
}

document.addEventListener("DOMContentLoaded",async()=>{bind();initPWA();updateSyncStatus();await init();});
