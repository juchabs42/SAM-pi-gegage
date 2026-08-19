const PESTS = {
  carpocapse: "Carpocapse",
  punaise_diabolique: "Punaise diabolique",
  cicadelle: "Cicadelle",
  mouche_mediterraneenne: "Mouche méditerranéenne",
  tordeuse: "Tordeuse"
};

const COLORS = ["#D31145", "#31688E", "#2E8B57", "#A56A00", "#744F9C", "#008C95", "#B04A3A", "#58636D"];

let db;
let currentUser = null;
let parcels = [];
let observations = [];
let chart = null;
let deferredInstallPrompt = null;
let pendingObservations = [];
let pendingParcels = [];
let syncInProgress = false;

const OFFLINE_DB_NAME = "sam-piegeage-offline";
const OFFLINE_DB_VERSION = 2;
const OFFLINE_STORE_PENDING = "pending_observations";
const OFFLINE_STORE_PENDING_PARCELS = "pending_parcels";
const OFFLINE_STORE_CACHE = "cache";
const INSTALL_STORAGE_KEY = "samPiegeageInstalled";

const $ = (id) => document.getElementById(id);

function setMessage(element, message = "", error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR");
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(value);
}


function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(OFFLINE_STORE_PENDING)) {
        database.createObjectStore(OFFLINE_STORE_PENDING, { keyPath: "id" });
      }

      if (!database.objectStoreNames.contains(OFFLINE_STORE_PENDING_PARCELS)) {
        database.createObjectStore(OFFLINE_STORE_PENDING_PARCELS, { keyPath: "id" });
      }

      if (!database.objectStoreNames.contains(OFFLINE_STORE_CACHE)) {
        database.createObjectStore(OFFLINE_STORE_CACHE, { keyPath: "key" });
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
    const request = tx.objectStore(storeName).getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
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

async function saveCachedData() {
  try {
    await idbPut(OFFLINE_STORE_CACHE, {
      key: "dataset",
      parcels,
      observations,
      saved_at: new Date().toISOString()
    });
  } catch (error) {
    console.warn("Cache local non enregistré :", error);
  }
}

async function loadCachedData() {
  try {
    const rows = await idbGetAll(OFFLINE_STORE_CACHE);
    return rows.find(row => row.key === "dataset") || null;
  } catch (error) {
    console.warn("Cache local non disponible :", error);
    return null;
  }
}

async function loadPendingObservations() {
  try {
    const rows = await idbGetAll(OFFLINE_STORE_PENDING);
    pendingObservations = rows
      .filter(row => !currentUser || row.created_by === currentUser.id)
      .sort((a, b) =>
        a.observed_on.localeCompare(b.observed_on) ||
        a.created_at.localeCompare(b.created_at)
      );
  } catch (error) {
    console.warn("File d'attente locale non disponible :", error);
    pendingObservations = [];
  }
}


async function loadPendingParcels() {
  try {
    const rows = await idbGetAll(OFFLINE_STORE_PENDING_PARCELS);
    pendingParcels = rows
      .filter(row => !currentUser || row.created_by === currentUser.id)
      .sort((a, b) =>
        a.exploitation.localeCompare(b.exploitation, "fr") ||
        a.name.localeCompare(b.name, "fr")
      );
  } catch (error) {
    console.warn("Parcelles locales en attente non disponibles :", error);
    pendingParcels = [];
  }
}

function displayParcels() {
  const remoteIds = new Set(parcels.map(parcel => parcel.id));

  return [
    ...parcels,
    ...pendingParcels.filter(parcel => !remoteIds.has(parcel.id))
  ];
}

function createOfflineParcel({ exploitation, name, variety, area }) {
  return {
    id: crypto.randomUUID(),
    exploitation,
    name,
    variety,
    area_ha: area,
    created_by: currentUser.id,
    created_at: new Date().toISOString(),
    _pending: true
  };
}

async function queueParcel(parcel) {
  await idbPut(OFFLINE_STORE_PENDING_PARCELS, parcel);
  pendingParcels.push(parcel);
  pendingParcels.sort((a, b) =>
    a.exploitation.localeCompare(b.exploitation, "fr") ||
    a.name.localeCompare(b.name, "fr")
  );
  updateSyncStatus();
}

async function removePendingParcel(id) {
  await idbDelete(OFFLINE_STORE_PENDING_PARCELS, id);
  pendingParcels = pendingParcels.filter(parcel => parcel.id !== id);
  updateSyncStatus();
}

async function remapPendingObservations(oldParcelId, newParcelId) {
  const affected = pendingObservations.filter(record => record.parcel_id === oldParcelId);

  for (const record of affected) {
    record.parcel_id = newParcelId;
    await idbPut(OFFLINE_STORE_PENDING, record);
  }
}

async function syncPendingParcels() {
  if (!navigator.onLine || !currentUser || !pendingParcels.length) return 0;

  let synced = 0;
  const queue = pendingParcels.slice();

  for (const parcel of queue) {
    if (parcel.created_by !== currentUser.id) continue;

    const payload = {
      id: parcel.id,
      exploitation: parcel.exploitation,
      name: parcel.name,
      variety: parcel.variety,
      area_ha: parcel.area_ha,
      created_by: parcel.created_by
    };

    const { data, error } = await db
      .from("piegeage_parcels")
      .insert(payload)
      .select("id, exploitation, name, variety, area_ha, created_by, created_at")
      .single();

    if (!error) {
      await removePendingParcel(parcel.id);
      if (!parcels.some(item => item.id === data.id)) parcels.push(data);
      synced += 1;
      continue;
    }

    if (error.code === "23505") {
      const { data: existing, error: lookupError } = await db
        .from("piegeage_parcels")
        .select("id, exploitation, name, variety, area_ha, created_by, created_at")
        .eq("exploitation", parcel.exploitation)
        .eq("name", parcel.name)
        .maybeSingle();

      if (!lookupError && existing) {
        await remapPendingObservations(parcel.id, existing.id);
        await removePendingParcel(parcel.id);
        if (!parcels.some(item => item.id === existing.id)) parcels.push(existing);
        synced += 1;
        continue;
      }
    }

    if (isNetworkError(error)) break;

    console.warn("Parcelle non synchronisée :", error);
  }

  parcels.sort((a, b) =>
    a.exploitation.localeCompare(b.exploitation, "fr") ||
    a.name.localeCompare(b.name, "fr")
  );

  return synced;
}

function displayObservations() {
  const remoteIds = new Set(observations.map(record => record.id));

  return [
    ...observations,
    ...pendingObservations.filter(record => !remoteIds.has(record.id))
  ];
}

function isNetworkError(error) {
  if (!navigator.onLine) return true;

  const message = String(error?.message || error || "");
  return /failed to fetch|network|load failed|fetch failed|networkerror/i.test(message);
}

function updateSyncStatus(message = null, mode = null) {
  const box = $("syncStatus");
  if (!box) return;

  box.classList.remove("hidden", "offline", "syncing", "success");

  if (message) {
    box.textContent = message;
    if (mode) box.classList.add(mode);
    return;
  }

  const parcelCount = pendingParcels.length;
  const observationCount = pendingObservations.length;
  const total = parcelCount + observationCount;

  const parts = [];
  if (parcelCount) {
    parts.push(`${parcelCount} parcelle${parcelCount > 1 ? "s" : ""}`);
  }
  if (observationCount) {
    parts.push(`${observationCount} relevé${observationCount > 1 ? "s" : ""}`);
  }

  if (!navigator.onLine) {
    box.textContent = total
      ? `Hors connexion — ${parts.join(" · ")} en attente`
      : "Hors connexion";
    box.classList.add("offline");
    return;
  }

  if (total) {
    box.textContent = `${parts.join(" · ")} en attente de synchronisation`;
    box.classList.add("syncing");
    return;
  }

  box.classList.add("hidden");
}
function showSyncSuccess(parcelCount, observationCount) {
  const parts = [];

  if (parcelCount) {
    parts.push(`${parcelCount} parcelle${parcelCount > 1 ? "s" : ""}`);
  }
  if (observationCount) {
    parts.push(`${observationCount} relevé${observationCount > 1 ? "s" : ""}`);
  }

  if (!parts.length) {
    updateSyncStatus();
    return;
  }

  updateSyncStatus(`${parts.join(" · ")} synchronisé${parcelCount + observationCount > 1 ? "s" : ""}`, "success");
  window.setTimeout(() => updateSyncStatus(), 3500);
}
function createOfflineObservation({ parcelId, pest, date, captures }) {
  const id = crypto.randomUUID();

  return {
    id,
    parcel_id: parcelId,
    pest,
    observed_on: date,
    captures,
    created_by: currentUser.id,
    created_at: new Date().toISOString(),
    _pending: true
  };
}

async function queueObservation(record) {
  await idbPut(OFFLINE_STORE_PENDING, record);
  pendingObservations.push(record);
  pendingObservations.sort((a, b) =>
    a.observed_on.localeCompare(b.observed_on) ||
    a.created_at.localeCompare(b.created_at)
  );
  updateSyncStatus();
}

async function removePendingObservation(id) {
  await idbDelete(OFFLINE_STORE_PENDING, id);
  pendingObservations = pendingObservations.filter(record => record.id !== id);
  updateSyncStatus();
}

async function syncPendingObservations() {
  if (!navigator.onLine || !currentUser || !pendingObservations.length) return 0;

  let synced = 0;
  const queue = pendingObservations.slice();

  for (const record of queue) {
    if (record.created_by !== currentUser.id) continue;

    const payload = {
      id: record.id,
      parcel_id: record.parcel_id,
      pest: record.pest,
      observed_on: record.observed_on,
      captures: record.captures,
      created_by: record.created_by
    };

    const { data, error } = await db
      .from("piegeage_observations")
      .insert(payload)
      .select("id, parcel_id, pest, observed_on, captures, created_by, created_at")
      .single();

    if (!error || error.code === "23505") {
      await removePendingObservation(record.id);

      if (data && !observations.some(item => item.id === data.id)) {
        observations.push(data);
      }

      synced += 1;
      continue;
    }

    if (isNetworkError(error)) break;

    console.warn("Relevé non synchronisé :", error);
  }

  observations.sort((a, b) =>
    a.observed_on.localeCompare(b.observed_on) ||
    a.created_at.localeCompare(b.created_at)
  );

  return synced;
}

async function syncPendingData() {
  if (syncInProgress || !navigator.onLine || !currentUser) {
    updateSyncStatus();
    return;
  }

  if (!pendingParcels.length && !pendingObservations.length) {
    updateSyncStatus();
    return;
  }

  syncInProgress = true;

  const parts = [];
  if (pendingParcels.length) parts.push(`${pendingParcels.length} parcelle${pendingParcels.length > 1 ? "s" : ""}`);
  if (pendingObservations.length) parts.push(`${pendingObservations.length} relevé${pendingObservations.length > 1 ? "s" : ""}`);

  updateSyncStatus(`Synchronisation de ${parts.join(" · ")}…`, "syncing");

  const syncedParcels = await syncPendingParcels();
  const syncedObservations = await syncPendingObservations();

  syncInProgress = false;

  if (syncedParcels || syncedObservations) {
    await saveCachedData();
    populateYears();
    populateFarms();
    populateEntryFarms();
    renderParcelList();
    refresh();
    showSyncSuccess(syncedParcels, syncedObservations);
  } else {
    updateSyncStatus();
  }
}

function configReady() {
  const c = window.SAM_CONFIG || {};
  return Boolean(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
}

async function init() {
  if (!configReady()) {
    setMessage($("globalMessage"), "Configuration Supabase absente dans config.js.", true);
    return;
  }

  db = window.supabase.createClient(
    window.SAM_CONFIG.SUPABASE_URL,
    window.SAM_CONFIG.SUPABASE_ANON_KEY
  );

  const { data: { session } } = await db.auth.getSession();
  currentUser = session?.user || null;
  await loadPendingParcels();
  await loadPendingObservations();
  renderAuth();

  db.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    await loadPendingParcels();
    await loadPendingObservations();
    renderAuth();

    if (currentUser && navigator.onLine) {
      await syncPendingData();
    }
  });

  await loadData();
}

function renderAuth() {
  const connected = Boolean(currentUser);

  $("loginForm").classList.toggle("hidden", connected);
  $("connectedBlock").classList.toggle("hidden", !connected);
  $("editActions").hidden = !connected;
  $("connectedEmail").textContent = currentUser?.email || "";

  const actionHeader = $("historyActionHeader");
  if (actionHeader) actionHeader.classList.toggle("hidden", !connected);

  if (!connected) {
    $("loginPassword").value = "";
  }

  renderHistory();
}

async function login(event) {
  if (event) event.preventDefault();

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  setMessage($("loginMessage"));

  if (!email || !password) {
    setMessage($("loginMessage"), "Renseignez l’adresse mail et le mot de passe.", true);
    return;
  }

  const submitButton = $("loginForm").querySelector("button[type='submit']");
  submitButton.disabled = true;

  const { error } = await db.auth.signInWithPassword({ email, password });

  submitButton.disabled = false;

  if (error) {
    setMessage(
      $("loginMessage"),
      "Connexion impossible. Vérifiez l’adresse mail et le mot de passe.",
      true
    );
    return;
  }

  setMessage($("loginMessage"));
  $("loginEmail").value = "";
  $("loginPassword").value = "";
  closeMobileAuthCard();
}

async function logout() {
  await db.auth.signOut();
  closeMobileAuthCard();
}

async function loadData() {
  setMessage($("globalMessage"), "Chargement…");

  const cached = await loadCachedData();

  if (!navigator.onLine && cached) {
    parcels = cached.parcels || [];
    observations = cached.observations || [];
    await loadPendingParcels();
    await loadPendingObservations();

    populateYears();
    populateFarms();
    populateEntryFarms();
    refresh();
    setMessage($("globalMessage"));
    updateSyncStatus();
    return;
  }

  const [p, o] = await Promise.all([
    db.from("piegeage_parcels")
      .select("id, exploitation, name, variety, area_ha, created_by, created_at")
      .order("exploitation")
      .order("name"),
    db.from("piegeage_observations")
      .select("id, parcel_id, pest, observed_on, captures, created_by, created_at")
      .order("observed_on")
      .order("created_at")
  ]);

  if (p.error || o.error) {
    if (cached && (isNetworkError(p.error) || isNetworkError(o.error))) {
      parcels = cached.parcels || [];
      observations = cached.observations || [];
      await loadPendingParcels();
      await loadPendingObservations();

      populateYears();
      populateFarms();
      populateEntryFarms();
      refresh();
      setMessage($("globalMessage"));
      updateSyncStatus();
      return;
    }

    setMessage(
      $("globalMessage"),
      `Impossible de charger les données : ${p.error?.message || o.error?.message}`,
      true
    );
    updateSyncStatus();
    return;
  }

  parcels = p.data || [];
  observations = o.data || [];
  await loadPendingParcels();
  await loadPendingObservations();
  await saveCachedData();

  populateYears();
  populateFarms();
  populateEntryFarms();
  refresh();
  setMessage($("globalMessage"));
  updateSyncStatus();

  if (currentUser && (pendingParcels.length || pendingObservations.length)) {
    await syncPendingData();
  }
}

function populateYears(preferred = null) {
  const select = $("yearSelect");
  const current = String(new Date().getFullYear());
  const previous = preferred || select.value;
  const years = [...new Set([current, ...displayObservations().map(o => o.observed_on.slice(0, 4))])]
    .sort((a, b) => b.localeCompare(a));

  select.innerHTML = "";
  years.forEach(y => select.add(new Option(y, y)));
  select.value = years.includes(previous) ? previous : years[0];
}

function populateFarms(preferred = null) {
  const select = $("farmSelect");
  const previous = preferred || select.value;
  const farms = [...new Set(displayParcels().map(p => p.exploitation))].sort((a, b) => a.localeCompare(b, "fr"));

  select.innerHTML = "";
  if (!farms.length) {
    select.add(new Option("Aucune exploitation", ""));
    select.disabled = true;
    populateParcelFilter();
    return;
  }

  select.disabled = false;
  farms.forEach(f => select.add(new Option(f, f)));
  select.value = farms.includes(previous) ? previous : farms[0];
  populateParcelFilter();
}

function populateParcelFilter(preferred = null) {
  const select = $("parcelSelect");
  const farm = $("farmSelect").value;
  const previous = preferred || select.value;
  const list = displayParcels()
    .filter(p => p.exploitation === farm)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  select.innerHTML = "";
  if (!list.length) {
    select.add(new Option("Aucune parcelle", ""));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.add(new Option("Toutes les parcelles", "all"));
  list.forEach(p => select.add(new Option(p.name, p.id)));
  select.value = previous === "all" || list.some(p => p.id === previous) ? previous : "all";
}

function populateEntryFarms(preferredFarm = null, preferredParcel = null) {
  const select = $("entryFarm");
  const farms = [...new Set(displayParcels().map(p => p.exploitation))].sort((a, b) => a.localeCompare(b, "fr"));
  const previous = preferredFarm || select.value;

  select.innerHTML = "";
  if (!farms.length) {
    select.add(new Option("Aucune exploitation", ""));
    select.disabled = true;
    populateEntryParcels();
    return;
  }

  select.disabled = false;
  farms.forEach(f => select.add(new Option(f, f)));
  select.value = farms.includes(previous) ? previous : farms[0];
  populateEntryParcels(preferredParcel);
}

function populateEntryParcels(preferred = null) {
  const select = $("entryParcel");
  const farm = $("entryFarm").value;
  const list = displayParcels()
    .filter(p => p.exploitation === farm)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  select.innerHTML = "";
  if (!list.length) {
    select.add(new Option("Aucune parcelle", ""));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  list.forEach(p => select.add(new Option(p.name, p.id)));
  if (preferred && list.some(p => p.id === preferred)) select.value = preferred;
}

function activeParcels() {
  const farm = $("farmSelect").value;
  const parcelValue = $("parcelSelect").value;
  const farmParcels = displayParcels().filter(p => p.exploitation === farm);
  return parcelValue === "all"
    ? farmParcels
    : farmParcels.filter(p => p.id === parcelValue);
}

function activeObservations() {
  const ids = new Set(activeParcels().map(p => p.id));
  const pest = $("pestSelect").value;
  const year = $("yearSelect").value;

  return displayObservations()
    .filter(o =>
      ids.has(o.parcel_id) &&
      (pest === "all" || o.pest === pest) &&
      o.observed_on.startsWith(year)
    )
    .sort((a, b) => a.observed_on.localeCompare(b.observed_on) || a.created_at.localeCompare(b.created_at));
}

function aggregateParcelRecords(records, mode) {
  const byDate = new Map();
  records.forEach(r => {
    if (!byDate.has(r.observed_on)) byDate.set(r.observed_on, []);
    byDate.get(r.observed_on).push(Number(r.captures));
  });

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      value: mode === "average"
        ? values.reduce((s, v) => s + v, 0) / values.length
        : values.reduce((s, v) => s + v, 0)
    }));
}

function buildParcelSeries() {
  const mode = $("calculationSelect").value;
  const pest = $("pestSelect").value;
  const year = $("yearSelect").value;
  const parcelsToShow = activeParcels();

  if (pest === "all") {
    return parcelsToShow.flatMap(parcel =>
      Object.keys(PESTS).map(pestKey => {
        const records = displayObservations().filter(
          o =>
            o.parcel_id === parcel.id &&
            o.pest === pestKey &&
            o.observed_on.startsWith(year)
        );

        return {
          parcel,
          pest: pestKey,
          label: `${parcel.name} — ${PESTS[pestKey]}`,
          points: aggregateParcelRecords(records, mode)
        };
      })
    ).filter(series => series.points.length);
  }

  return parcelsToShow.map(parcel => {
    const records = displayObservations().filter(
      o => o.parcel_id === parcel.id && o.pest === pest && o.observed_on.startsWith(year)
    );

    return {
      parcel,
      pest,
      label: parcel.name,
      points: aggregateParcelRecords(records, mode)
    };
  }).filter(series => series.points.length);
}

function cumulativePoints(points) {
  let total = 0;
  return points.map(p => ({ date: p.date, value: (total += p.value) }));
}

function metricSeries() {
  const mode = $("calculationSelect").value;
  const records = activeObservations();
  const grouped = new Map();

  records.forEach(r => {
    if (!grouped.has(r.observed_on)) grouped.set(r.observed_on, []);
    grouped.get(r.observed_on).push(Number(r.captures));
  });

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      value: mode === "average"
        ? values.reduce((s, v) => s + v, 0) / values.length
        : values.reduce((s, v) => s + v, 0)
    }));
}

function trend(values) {
  if (values.length < 2) return "À compléter";
  const last = values.at(-1);
  const base = values.length >= 3 ? (values.at(-2) + values.at(-3)) / 2 : values.at(-2);
  if (Math.abs(last - base) < 0.5) return "Stable";
  return last > base ? "En augmentation" : "En diminution";
}

function refresh() {
  renderMetrics();
  renderChart();
  renderHistory();
}

function renderMetrics() {
  const records = activeObservations();
  const series = metricSeries();
  const values = series.map(x => x.value);
  const last = series.at(-1);

  $("lastValue").textContent = last ? `${formatNumber(last.value)} captures` : "—";
  $("lastDate").textContent = last ? `Relevé du ${formatDate(last.date)}` : "Aucune donnée";
  $("trendValue").textContent = trend(values);
  $("seasonTotal").textContent = values.length ? formatNumber(values.reduce((s, v) => s + v, 0)) : "—";
  $("seasonUnit").textContent = $("calculationSelect").value === "average"
    ? "somme des moyennes par date"
    : "captures cumulées";
  $("recordCount").textContent = String(records.length);

  const latestCreated = records.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
  $("lastUpdate").textContent = latestCreated ? `Dernière saisie : ${formatDateTime(latestCreated.created_at)}` : "Aucune mise à jour";
}

function renderChart() {
  if (chart) {
    chart.destroy();
    chart = null;
  }

  const canvas = $("trapChart");
  const empty = $("chartEmpty");
  const series = buildParcelSeries();
  const display = $("displaySelect").value;

  if (!series.length) {
    canvas.style.display = "none";
    empty.style.display = "grid";
    empty.textContent = "Aucune donnée pour cette sélection.";
    $("chartTitle").textContent = "Captures par relevé";
    return;
  }

  canvas.style.display = "block";
  empty.style.display = "none";

  const allDates = [...new Set(
    series.flatMap(s => (display === "cumulative" ? cumulativePoints(s.points) : s.points).map(p => p.date))
  )].sort();

  const datasets = series.map((s, index) => {
    const points = display === "cumulative" ? cumulativePoints(s.points) : s.points;
    const map = new Map(points.map(p => [p.date, p.value]));
    return {
      label: s.label || s.parcel.name,
      data: allDates.map(date => map.has(date) ? map.get(date) : null),
      borderColor: COLORS[index % COLORS.length],
      backgroundColor: COLORS[index % COLORS.length],
      tension: 0.22,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2.4,
      spanGaps: true
    };
  });

  const selectedPest = $("pestSelect").value;
  const pestLabel = selectedPest === "all" ? "Tous les ravageurs" : PESTS[selectedPest];

  $("chartTitle").textContent = display === "cumulative"
    ? `Cumul saisonnier — ${pestLabel}`
    : `Dynamique des captures — ${pestLabel}`;

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: allDates.map(formatDate),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          position: "bottom",
          labels: { usePointStyle: true, boxWidth: 8, padding: 17 }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: display === "cumulative"
              ? "Cumul des captures"
              : ($("calculationSelect").value === "average" ? "Moyenne des captures" : "Total des captures")
          },
          grid: { color: "rgba(102,113,123,.13)" }
        }
      }
    }
  });
}

function renderHistory() {
  const tbody = $("historyBody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const records = activeObservations().slice().sort(
    (a, b) => b.observed_on.localeCompare(a.observed_on) || b.created_at.localeCompare(a.created_at)
  );

  const connected = Boolean(currentUser);
  const actionHeader = $("historyActionHeader");
  if (actionHeader) actionHeader.classList.toggle("hidden", !connected);

  if (!records.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    row.innerHTML = `<td colspan="${connected ? 6 : 5}">Aucun relevé enregistré pour cette sélection.</td>`;
    tbody.appendChild(row);
    return;
  }

  const parcelMap = new Map(displayParcels().map(p => [p.id, p.name]));

  records.forEach(record => {
    const row = document.createElement("tr");
    if (record._pending) row.classList.add("pending-row");

    const values = [
      ["Date", formatDate(record.observed_on)],
      ["Parcelle", parcelMap.get(record.parcel_id) || "—"],
      ["Ravageur", PESTS[record.pest] || record.pest],
      ["Captures", formatNumber(record.captures, 0)],
      ["Enregistré", record._pending ? "En attente de synchronisation" : formatDateTime(record.created_at)]
    ];

    values.forEach(([label, text], index) => {
      const td = document.createElement("td");
      td.textContent = text;
      td.dataset.label = label;
      if (index === 3) td.style.fontWeight = "800";
      row.appendChild(td);
    });

    if (connected) {
      const actionCell = document.createElement("td");
      actionCell.dataset.label = "Action";
      actionCell.className = "history-action-cell";

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-row-button";
      deleteButton.textContent = "Supprimer";
      deleteButton.addEventListener("click", () => deleteObservation(record));

      actionCell.appendChild(deleteButton);
      row.appendChild(actionCell);
    }

    tbody.appendChild(row);
  });
}

async function deleteObservation(record) {
  if (!currentUser) return;

  const confirmed = window.confirm(
    record._pending
      ? "Supprimer ce relevé en attente de synchronisation ?"
      : "Supprimer définitivement ce relevé ?"
  );

  if (!confirmed) return;

  if (record._pending) {
    await removePendingObservation(record.id);
    refresh();
    setMessage($("globalMessage"), "Relevé supprimé.");
    return;
  }

  const { error } = await db
    .from("piegeage_observations")
    .delete()
    .eq("id", record.id);

  if (error) {
    setMessage(
      $("globalMessage"),
      `Suppression impossible : ${error.message}`,
      true
    );
    return;
  }

  observations = observations.filter(item => item.id !== record.id);
  await saveCachedData();
  refresh();
  setMessage($("globalMessage"), "Relevé supprimé.");

  window.setTimeout(() => {
    if ($("globalMessage").textContent === "Relevé supprimé.") {
      setMessage($("globalMessage"));
    }
  }, 3000);
}

async function createParcel(event) {
  event.preventDefault();
  if (!currentUser) return;

  setMessage($("parcelMessage"));

  const exploitation = $("parcelFarm").value.trim();
  const name = $("parcelName").value.trim();
  const variety = $("parcelVariety").value.trim();
  const area = Number($("parcelArea").value);

  if (!exploitation || !name || !variety || !Number.isFinite(area) || area < 0) {
    setMessage($("parcelMessage"), "Renseignez tous les champs.", true);
    return;
  }

  const duplicate = displayParcels().some(parcel =>
    parcel.exploitation.trim().toLowerCase() === exploitation.toLowerCase() &&
    parcel.name.trim().toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    setMessage($("parcelMessage"), "Cette parcelle existe déjà pour cette exploitation.", true);
    return;
  }

  const localParcel = createOfflineParcel({
    exploitation,
    name,
    variety,
    area
  });

  let savedOnline = false;
  let savedParcel = localParcel;

  if (navigator.onLine) {
    const { data, error } = await db
      .from("piegeage_parcels")
      .insert({
        id: localParcel.id,
        exploitation: localParcel.exploitation,
        name: localParcel.name,
        variety: localParcel.variety,
        area_ha: localParcel.area_ha,
        created_by: localParcel.created_by
      })
      .select("id, exploitation, name, variety, area_ha, created_by, created_at")
      .single();

    if (!error) {
      parcels.push(data);
      savedOnline = true;
      savedParcel = data;
      await saveCachedData();
    } else if (!isNetworkError(error)) {
      setMessage(
        $("parcelMessage"),
        error.code === "23505"
          ? "Cette parcelle existe déjà pour cette exploitation."
          : `Création impossible : ${error.message}`,
        true
      );
      return;
    }
  }

  if (!savedOnline) {
    await queueParcel(localParcel);
  }

  $("parcelForm").reset();

  populateFarms(savedParcel.exploitation);
  populateEntryFarms(savedParcel.exploitation, savedParcel.id);
  $("parcelSelect").value = savedParcel.id;
  renderParcelList();
  refresh();

  setMessage(
    $("parcelMessage"),
    savedOnline
      ? "Parcelle créée."
      : "Parcelle créée hors connexion. Elle sera synchronisée automatiquement."
  );

  updateSyncStatus();
}

async function createObservation(event) {
  event.preventDefault();
  if (!currentUser) return;

  setMessage($("observationMessage"));

  const parcelId = $("entryParcel").value;
  const pest = $("entryPest").value;
  const date = $("observationDate").value;
  const captures = Number($("observationCount").value);

  if (!parcelId || !pest || !date || !Number.isInteger(captures) || captures < 0) {
    setMessage($("observationMessage"), "Renseignez tous les champs correctement.", true);
    return;
  }

  const localRecord = createOfflineObservation({
    parcelId,
    pest,
    date,
    captures
  });

  let savedOnline = false;

  if (navigator.onLine) {
    const { data, error } = await db
      .from("piegeage_observations")
      .insert({
        id: localRecord.id,
        parcel_id: localRecord.parcel_id,
        pest: localRecord.pest,
        observed_on: localRecord.observed_on,
        captures: localRecord.captures,
        created_by: localRecord.created_by
      })
      .select("id, parcel_id, pest, observed_on, captures, created_by, created_at")
      .single();

    if (!error) {
      observations.push(data);
      observations.sort((a, b) =>
        a.observed_on.localeCompare(b.observed_on) ||
        a.created_at.localeCompare(b.created_at)
      );
      savedOnline = true;
      await saveCachedData();
    } else if (!isNetworkError(error)) {
      setMessage(
        $("observationMessage"),
        `Enregistrement impossible : ${error.message}`,
        true
      );
      return;
    }
  }

  if (!savedOnline) {
    await queueObservation(localRecord);
  }

  populateYears(date.slice(0, 4));

  const parcel = displayParcels().find(p => p.id === parcelId);
  if (parcel) {
    populateFarms(parcel.exploitation);
    $("parcelSelect").value = parcel.id;
  }

  $("pestSelect").value = pest;
  $("yearSelect").value = date.slice(0, 4);
  $("observationCount").value = "";

  refresh();

  setMessage(
    $("observationMessage"),
    savedOnline
      ? "Relevé enregistré."
      : "Relevé enregistré hors connexion. Il sera synchronisé automatiquement."
  );

  if (!savedOnline) {
    updateSyncStatus();
  }
}

function exportCsv() {
  const records = activeObservations();
  const parcelMap = new Map(displayParcels().map(p => [p.id, p]));
  const rows = [["Ravageur", "Année", "Exploitation", "Parcelle", "Variété", "Surface (ha)", "Date du relevé", "Captures"]];

  records.forEach(r => {
    const p = parcelMap.get(r.parcel_id);
    rows.push([
      PESTS[r.pest] || r.pest,
      r.observed_on.slice(0, 4),
      p?.exploitation || "",
      p?.name || "",
      p?.variety || "",
      p?.area_ha ?? "",
      r.observed_on,
      r.captures
    ]);
  });

  const quote = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const csv = "\ufeff" + rows.map(row => row.map(quote).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `sam_piegeage_${$("yearSelect").value}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}


function renderParcelList() {
  const container = $("parcelList");
  if (!container) return;

  container.innerHTML = "";

  const list = displayParcels().slice().sort((a, b) =>
    a.exploitation.localeCompare(b.exploitation, "fr") ||
    a.name.localeCompare(b.name, "fr")
  );

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "parcel-list-empty";
    empty.textContent = "Aucune parcelle créée.";
    container.appendChild(empty);
    return;
  }

  list.forEach(parcel => {
    const row = document.createElement("div");
    row.className = "parcel-list-item";
    if (parcel._pending) row.classList.add("pending-parcel");

    const info = document.createElement("div");
    info.className = "parcel-list-info";

    const title = document.createElement("strong");
    title.textContent = `${parcel.exploitation} — ${parcel.name}`;

    const meta = document.createElement("span");
    meta.textContent = `${parcel.variety} · ${formatNumber(parcel.area_ha, 2)} ha${parcel._pending ? " · En attente de synchronisation" : ""}`;

    info.append(title, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "delete-parcel-button";
    button.textContent = "Supprimer";
    button.addEventListener("click", () => deleteParcel(parcel));

    row.append(info, button);
    container.appendChild(row);
  });
}

async function deleteParcel(parcel) {
  if (!currentUser) return;

  const linkedObservations = displayObservations().filter(
    record => record.parcel_id === parcel.id
  );

  const warning = linkedObservations.length
    ? `Supprimer la parcelle « ${parcel.name} » et ses ${linkedObservations.length} relevé${linkedObservations.length > 1 ? "s" : ""} ?`
    : `Supprimer la parcelle « ${parcel.name} » ?`;

  if (!window.confirm(warning)) return;

  if (parcel._pending) {
    const pendingForParcel = pendingObservations.filter(
      record => record.parcel_id === parcel.id
    );

    for (const record of pendingForParcel) {
      await removePendingObservation(record.id);
    }

    await removePendingParcel(parcel.id);

    populateFarms();
    populateEntryFarms();
    renderParcelList();
    refresh();
    setMessage($("parcelMessage"), "Parcelle supprimée.");
    return;
  }

  if (!navigator.onLine) {
    setMessage(
      $("parcelMessage"),
      "La suppression d’une parcelle déjà synchronisée nécessite une connexion internet.",
      true
    );
    return;
  }

  const { error } = await db
    .from("piegeage_parcels")
    .delete()
    .eq("id", parcel.id);

  if (error) {
    setMessage(
      $("parcelMessage"),
      `Suppression impossible : ${error.message}`,
      true
    );
    return;
  }

  parcels = parcels.filter(item => item.id !== parcel.id);
  observations = observations.filter(record => record.parcel_id !== parcel.id);

  const pendingForParcel = pendingObservations.filter(
    record => record.parcel_id === parcel.id
  );
  for (const record of pendingForParcel) {
    await removePendingObservation(record.id);
  }

  await saveCachedData();

  populateFarms();
  populateEntryFarms();
  renderParcelList();
  refresh();

  setMessage($("parcelMessage"), "Parcelle supprimée.");
}

function openParcelDialog() {
  if (!currentUser) return;
  setMessage($("parcelMessage"));
  renderParcelList();
  $("parcelDialog").showModal();
}

function openObservationDialog() {
  if (!currentUser) return;
  setMessage($("observationMessage"));

  if (!displayParcels().length) {
    setMessage($("globalMessage"), "Créez d’abord une parcelle.", true);
    return;
  }

  const currentFarm = $("farmSelect").value;
  const currentParcel = $("parcelSelect").value;
  populateEntryFarms(currentFarm, currentParcel !== "all" ? currentParcel : null);
  $("entryPest").value = $("pestSelect").value === "all"
    ? "carpocapse"
    : $("pestSelect").value;
  $("observationDate").value = new Date().toISOString().slice(0, 10);
  $("observationDialog").showModal();
}


function toggleMobileAuthCard() {
  const card = $("authCard");
  const button = $("authToggleButton");
  if (!card || !button || window.innerWidth > 720) return;

  const open = card.classList.toggle("open");
  button.setAttribute("aria-expanded", String(open));
}

function closeMobileAuthCard() {
  const card = $("authCard");
  const button = $("authToggleButton");
  if (!card || !button || window.innerWidth > 720) return;

  card.classList.remove("open");
  button.setAttribute("aria-expanded", "false");
}

function isAppMarkedInstalled() {
  return window.localStorage.getItem(INSTALL_STORAGE_KEY) === "1";
}

function markAppInstalled() {
  window.localStorage.setItem(INSTALL_STORAGE_KEY, "1");
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isMobileDevice() {
  if (navigator.userAgentData &&
      typeof navigator.userAgentData.mobile === "boolean") {
    return navigator.userAgentData.mobile;
  }

  const ua = navigator.userAgent || "";
  const mobileUa = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(ua);
  const iPadDesktopMode =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

  return mobileUa || iPadDesktopMode;
}

function showInstallMessage(message) {
  const box = $("installMessage");
  if (!box) return;

  box.textContent = message;
  box.classList.remove("hidden");

  window.clearTimeout(showInstallMessage.timer);
  showInstallMessage.timer =
    window.setTimeout(() => box.classList.add("hidden"), 7000);
}

async function installApp() {
  if (isStandalone()) return;

  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;

    if (result.outcome === "accepted") {
      markAppInstalled();
      $("installCard").classList.add("hidden");
    }
    return;
  }

  if (isIOS()) {
    showInstallMessage(
      "Sur iPhone/iPad : ouvre cette page dans Safari, touche Partager, puis « Sur l’écran d’accueil »."
    );
  } else {
    showInstallMessage(
      "Si l’installation ne s’ouvre pas, utilise le menu du navigateur puis « Installer l’application » ou « Ajouter à l’écran d’accueil »."
    );
  }
}

function initPWA() {
  const installCard = $("installCard");
  const installButton = $("installButton");
  const mobile = isMobileDevice();

  if (!installCard || !installButton) return;

  if (isStandalone()) {
    markAppInstalled();
  }

  const alreadyInstalled = isStandalone() || isAppMarkedInstalled();

  if (!mobile || alreadyInstalled) {
    installCard.classList.add("hidden");
  } else {
    installCard.classList.remove("hidden");
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;

    if (mobile && !isStandalone() && !isAppMarkedInstalled()) {
      installCard.classList.remove("hidden");
      installButton.classList.remove("hidden");
    }
  });

  const standaloneMedia = window.matchMedia("(display-mode: standalone)");
  const handleDisplayModeChange = () => {
    if (isStandalone()) {
      markAppInstalled();
      installCard.classList.add("hidden");
    }
  };

  if (standaloneMedia.addEventListener) {
    standaloneMedia.addEventListener("change", handleDisplayModeChange);
  }

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    markAppInstalled();
    installCard.classList.add("hidden");
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration =
          await navigator.serviceWorker.register("./service-worker.js");
        await registration.update();
      } catch (error) {
        console.warn("Service worker non enregistré :", error);
      }
    });
  }
}


function bind() {
  $("installButton").addEventListener("click", installApp);
  $("authToggleButton").addEventListener("click", toggleMobileAuthCard);
  $("loginForm").addEventListener("submit", login);
  $("logoutButton").addEventListener("click", logout);

  $("addParcelButton").addEventListener("click", openParcelDialog);
  $("addObservationButton").addEventListener("click", openObservationDialog);
  $("closeParcelDialog").addEventListener("click", () => $("parcelDialog").close());
  $("closeObservationDialog").addEventListener("click", () => $("observationDialog").close());

  $("parcelForm").addEventListener("submit", createParcel);
  $("observationForm").addEventListener("submit", createObservation);

  $("entryFarm").addEventListener("change", () => populateEntryParcels());

  $("pestSelect").addEventListener("change", refresh);
  $("yearSelect").addEventListener("change", refresh);
  $("calculationSelect").addEventListener("change", refresh);
  $("displaySelect").addEventListener("change", refresh);

  $("farmSelect").addEventListener("change", () => {
    populateParcelFilter("all");
    refresh();
  });
  $("parcelSelect").addEventListener("change", refresh);

  $("exportCsvButton").addEventListener("click", exportCsv);

  window.addEventListener("offline", () => {
    updateSyncStatus();
  });

  window.addEventListener("online", async () => {
    updateSyncStatus("Connexion retrouvée — synchronisation…", "syncing");
    await syncPendingData();
    await loadData();
  });

  [$("parcelDialog"), $("observationDialog")].forEach(dialog => {
    dialog.addEventListener("click", e => {
      if (e.target === dialog) dialog.close();
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bind();
  initPWA();
  updateSyncStatus();
  await init();
});
