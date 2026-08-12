const PESTS = {
  carpocapse: "Carpocapse",
  punaise_diabolique: "Punaise diabolique",
  cicadelle: "Cicadelle",
  mouche_mediterraneenne: "Mouche méditerranéenne",
  tordeuse: "Tordeuse"
};

const SAM_COLOR = "#D31145";
const SAM_COLOR_SOFT = "rgba(211, 17, 69, 0.10)";

let db = null;
let currentUser = null;
let parcels = [];
let observations = [];
let trapChart = null;

const el = (id) => document.getElementById(id);

function configIsReady() {
  const cfg = window.SAM_CONFIG || {};
  return Boolean(
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("VOTRE-PROJET") &&
    !cfg.SUPABASE_ANON_KEY.includes("VOTRE_CLE")
  );
}

function setMessage(target, message = "", isError = false) {
  target.textContent = message;
  target.classList.toggle("error", isError);
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR");
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: digits
  }).format(value);
}

function escapeCsv(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function showState(state) {
  el("setupState").hidden = state !== "setup";
  el("authState").hidden = state !== "auth";
  el("appState").hidden = state !== "app";

  const connected = state === "app";
  el("signOutButton").hidden = !connected;
  el("manageParcelsButton").hidden = !connected;
  el("userEmail").textContent = connected ? (currentUser?.email || "") : "";
}

async function bootstrap() {
  if (!configIsReady()) {
    showState("setup");
    return;
  }

  db = window.supabase.createClient(
    window.SAM_CONFIG.SUPABASE_URL,
    window.SAM_CONFIG.SUPABASE_ANON_KEY
  );

  const { data: { session } } = await db.auth.getSession();
  currentUser = session?.user || null;

  db.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (currentUser) {
      showState("app");
      await loadAllData();
    } else {
      showState("auth");
      resetAppData();
    }
  });

  if (currentUser) {
    showState("app");
    await loadAllData();
  } else {
    showState("auth");
  }
}

function resetAppData() {
  parcels = [];
  observations = [];
  if (trapChart) {
    trapChart.destroy();
    trapChart = null;
  }
}

async function signIn(event) {
  event.preventDefault();
  setMessage(el("authMessage"));

  const email = el("authEmail").value.trim();
  const password = el("authPassword").value;

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    setMessage(el("authMessage"), `Connexion impossible : ${error.message}`, true);
  }
}

async function signUp() {
  setMessage(el("authMessage"));

  const email = el("authEmail").value.trim();
  const password = el("authPassword").value;

  if (!email || password.length < 6) {
    setMessage(el("authMessage"), "Renseignez un e-mail et un mot de passe d’au moins 6 caractères.", true);
    return;
  }

  const { data, error } = await db.auth.signUp({ email, password });
  if (error) {
    setMessage(el("authMessage"), `Création impossible : ${error.message}`, true);
    return;
  }

  if (data.session) {
    setMessage(el("authMessage"), "Compte créé.");
  } else {
    setMessage(el("authMessage"), "Compte créé. Validez l’e-mail de confirmation avant de vous connecter.");
  }
}

async function signOut() {
  await db.auth.signOut();
}

async function loadAllData() {
  setMessage(el("globalMessage"), "Chargement des données…");

  const [parcelResult, observationResult] = await Promise.all([
    db.from("parcels")
      .select("id, exploitation, name, variety, area_ha, created_by, created_at")
      .order("exploitation", { ascending: true })
      .order("name", { ascending: true }),
    db.from("trap_observations")
      .select("id, parcel_id, pest, observed_on, captures, created_by, created_at")
      .order("observed_on", { ascending: true })
      .order("created_at", { ascending: true })
  ]);

  if (parcelResult.error || observationResult.error) {
    const message = parcelResult.error?.message || observationResult.error?.message;
    setMessage(el("globalMessage"), `Impossible de charger Supabase : ${message}`, true);
    return;
  }

  parcels = parcelResult.data || [];
  observations = observationResult.data || [];

  populateYearFilter();
  populateFarmFilter();
  renderParcelList();
  refreshDashboard();

  setMessage(el("globalMessage"));
}

function populateYearFilter(preferredYear = null) {
  const select = el("yearSelect");
  const previous = preferredYear || select.value;
  const currentYear = String(new Date().getFullYear());
  const years = [...new Set([currentYear, ...observations.map(item => item.observed_on.slice(0, 4))])]
    .sort((a, b) => b.localeCompare(a));

  select.innerHTML = "";
  years.forEach(year => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    select.appendChild(option);
  });

  select.value = years.includes(previous) ? previous : years[0];
}

function populateFarmFilter(preferredFarm = null, preferredParcelId = null) {
  const farmSelect = el("farmSelect");
  const previousFarm = preferredFarm || farmSelect.value;
  const farms = [...new Set(parcels.map(parcel => parcel.exploitation))]
    .sort((a, b) => a.localeCompare(b, "fr"));

  farmSelect.innerHTML = "";

  if (!farms.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Aucune exploitation";
    farmSelect.appendChild(option);
    farmSelect.disabled = true;
    populateParcelFilter(null);
    return;
  }

  farmSelect.disabled = false;
  farms.forEach(farm => {
    const option = document.createElement("option");
    option.value = farm;
    option.textContent = farm;
    farmSelect.appendChild(option);
  });

  farmSelect.value = farms.includes(previousFarm) ? previousFarm : farms[0];
  populateParcelFilter(preferredParcelId);
}

function populateParcelFilter(preferredParcelId = null) {
  const parcelSelect = el("parcelSelect");
  const previous = preferredParcelId || parcelSelect.value;
  const farm = el("farmSelect").value;

  const filtered = parcels
    .filter(parcel => parcel.exploitation === farm)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  parcelSelect.innerHTML = "";

  if (!filtered.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Aucune parcelle";
    parcelSelect.appendChild(option);
    parcelSelect.disabled = true;
    return;
  }

  parcelSelect.disabled = false;
  filtered.forEach(parcel => {
    const option = document.createElement("option");
    option.value = parcel.id;
    option.textContent = parcel.name;
    parcelSelect.appendChild(option);
  });

  parcelSelect.value = filtered.some(parcel => parcel.id === previous)
    ? previous
    : filtered[0].id;
}

function selectedParcel() {
  return parcels.find(parcel => parcel.id === el("parcelSelect").value) || null;
}

function filteredObservations() {
  const parcel = selectedParcel();
  if (!parcel) return [];

  return observations
    .filter(item =>
      item.parcel_id === parcel.id &&
      item.pest === el("pestSelect").value &&
      item.observed_on.startsWith(el("yearSelect").value)
    )
    .sort((a, b) =>
      a.observed_on.localeCompare(b.observed_on) ||
      a.created_at.localeCompare(b.created_at)
    );
}

function aggregateByDate(records, mode) {
  const groups = new Map();

  records.forEach(record => {
    if (!groups.has(record.observed_on)) groups.set(record.observed_on, []);
    groups.get(record.observed_on).push(Number(record.captures));
  });

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      value: mode === "average"
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : values.reduce((sum, value) => sum + value, 0),
      entries: values.length
    }));
}

function cumulative(values) {
  let total = 0;
  return values.map(value => {
    total += value;
    return total;
  });
}

function calculateTrend(values) {
  if (values.length < 2) return "À compléter";

  const last = values.at(-1);
  const prior = values.length >= 3
    ? (values.at(-2) + values.at(-3)) / 2
    : values.at(-2);

  const delta = last - prior;
  if (Math.abs(delta) < 0.5) return "Stable";
  return delta > 0 ? "En augmentation" : "En diminution";
}

function refreshDashboard() {
  updateSelectedParcelSummary();

  const records = filteredObservations();
  const mode = el("calculationSelect").value;
  const display = el("displaySelect").value;
  const series = aggregateByDate(records, mode);
  const values = series.map(item => item.value);
  const plottedValues = display === "cumulative" ? cumulative(values) : values;
  const last = series.at(-1);

  const unit = mode === "average" ? "captures en moyenne" : "captures";
  el("lastValue").textContent = last ? `${formatNumber(last.value)} ${mode === "average" ? "captures" : "captures"}` : "—";
  el("lastDate").textContent = last ? `Relevé du ${formatDate(last.date)}` : "Aucune donnée";
  el("trendValue").textContent = calculateTrend(values);
  el("seasonTotal").textContent = series.length ? formatNumber(values.reduce((sum, value) => sum + value, 0)) : "—";
  el("seasonUnit").textContent = mode === "average" ? "somme des moyennes par date" : "captures cumulées";
  el("recordCount").textContent = String(records.length);
  el("lastUpdate").textContent = records.length
    ? `Dernier enregistrement : ${formatDateTime(records.at(-1).created_at)}`
    : "Aucune mise à jour";

  renderChart(series, plottedValues, mode, display);
  renderHistory(records);
  setEntryAvailability(Boolean(selectedParcel()));
}

function renderChart(series, plottedValues, mode, display) {
  if (trapChart) {
    trapChart.destroy();
    trapChart = null;
  }

  const canvas = el("trapChart");
  const empty = el("chartEmpty");
  const parcel = selectedParcel();
  const pestLabel = PESTS[el("pestSelect").value] || el("pestSelect").value;

  if (!series.length || !parcel) {
    canvas.style.display = "none";
    empty.style.display = "grid";
    empty.textContent = parcel
      ? "Aucun relevé pour cette sélection."
      : "Créez une parcelle puis ajoutez un premier relevé.";
    el("chartTitle").textContent = "Captures par relevé";
    return;
  }

  canvas.style.display = "block";
  empty.style.display = "none";

  el("chartTitle").textContent = display === "cumulative"
    ? `Cumul saisonnier — ${pestLabel}`
    : `Dynamique des captures — ${pestLabel}`;

  trapChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: series.map(item => formatDate(item.date)),
      datasets: [{
        label: `${parcel.name} — ${pestLabel}`,
        data: plottedValues,
        borderColor: SAM_COLOR,
        backgroundColor: SAM_COLOR_SOFT,
        fill: true,
        tension: 0.25,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: "index"
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 8,
            padding: 18
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: display === "cumulative"
              ? "Cumul des captures"
              : (mode === "average" ? "Moyenne des captures" : "Total des captures")
          },
          grid: { color: "rgba(102, 113, 123, 0.13)" }
        }
      }
    }
  });
}

function renderHistory(records) {
  const tbody = el("historyBody");
  tbody.innerHTML = "";

  if (!records.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    row.innerHTML = `<td colspan="3">Aucun relevé enregistré pour cette sélection.</td>`;
    tbody.appendChild(row);
    return;
  }

  records
    .slice()
    .sort((a, b) =>
      b.observed_on.localeCompare(a.observed_on) ||
      b.created_at.localeCompare(a.created_at)
    )
    .forEach(record => {
      const row = document.createElement("tr");

      const date = document.createElement("td");
      date.textContent = formatDate(record.observed_on);

      const captures = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = formatNumber(record.captures, 0);
      captures.appendChild(strong);

      const created = document.createElement("td");
      created.textContent = formatDateTime(record.created_at);

      row.append(date, captures, created);
      tbody.appendChild(row);
    });
}

function updateSelectedParcelSummary() {
  const parcel = selectedParcel();
  const box = el("selectedParcelSummary");

  if (!parcel) {
    box.innerHTML = "<strong>Aucune parcelle sélectionnée</strong>Créez d’abord une parcelle.";
    return;
  }

  box.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = `${parcel.exploitation} — ${parcel.name}`;
  const details = document.createElement("span");
  details.textContent = `${parcel.variety} · ${formatNumber(parcel.area_ha, 2)} ha`;
  box.append(title, details);
}

function setEntryAvailability(enabled) {
  el("observationDate").disabled = !enabled;
  el("observationCount").disabled = !enabled;
  el("observationForm").querySelector("button").disabled = !enabled;
  el("exportCsvButton").disabled = !enabled;
}

async function saveObservation(event) {
  event.preventDefault();
  setMessage(el("observationMessage"));

  const parcel = selectedParcel();
  if (!parcel) {
    setMessage(el("observationMessage"), "Créez et sélectionnez une parcelle avant d’ajouter un relevé.", true);
    return;
  }

  const observedOn = el("observationDate").value;
  const captures = Number(el("observationCount").value);

  if (!observedOn || !Number.isInteger(captures) || captures < 0) {
    setMessage(el("observationMessage"), "Renseignez une date et un nombre entier de captures.", true);
    return;
  }

  const payload = {
    parcel_id: parcel.id,
    pest: el("pestSelect").value,
    observed_on: observedOn,
    captures,
    created_by: currentUser.id
  };

  const { data, error } = await db
    .from("trap_observations")
    .insert(payload)
    .select("id, parcel_id, pest, observed_on, captures, created_by, created_at")
    .single();

  if (error) {
    setMessage(el("observationMessage"), `Enregistrement impossible : ${error.message}`, true);
    return;
  }

  observations.push(data);
  observations.sort((a, b) =>
    a.observed_on.localeCompare(b.observed_on) ||
    a.created_at.localeCompare(b.created_at)
  );

  populateYearFilter(observedOn.slice(0, 4));
  el("observationForm").reset();
  el("observationDate").value = observedOn;
  setMessage(el("observationMessage"), "Relevé enregistré dans Supabase.");
  refreshDashboard();
}

async function saveParcel(event) {
  event.preventDefault();
  setMessage(el("parcelMessage"));

  const exploitation = el("parcelFarm").value.trim();
  const name = el("parcelName").value.trim();
  const variety = el("parcelVariety").value.trim();
  const area = Number(el("parcelArea").value);

  if (!exploitation || !name || !variety || !Number.isFinite(area) || area < 0) {
    setMessage(el("parcelMessage"), "Renseignez l’exploitation, la parcelle, la variété et une surface valide.", true);
    return;
  }

  const payload = {
    exploitation,
    name,
    variety,
    area_ha: area,
    created_by: currentUser.id
  };

  const { data, error } = await db
    .from("parcels")
    .insert(payload)
    .select("id, exploitation, name, variety, area_ha, created_by, created_at")
    .single();

  if (error) {
    const friendly = error.code === "23505"
      ? "Cette parcelle existe déjà pour cette exploitation."
      : `Création impossible : ${error.message}`;
    setMessage(el("parcelMessage"), friendly, true);
    return;
  }

  parcels.push(data);
  parcels.sort((a, b) =>
    a.exploitation.localeCompare(b.exploitation, "fr") ||
    a.name.localeCompare(b.name, "fr")
  );

  el("parcelForm").reset();
  setMessage(el("parcelMessage"), "Parcelle créée.");
  populateFarmFilter(data.exploitation, data.id);
  renderParcelList();
  refreshDashboard();
}

function renderParcelList() {
  const container = el("parcelList");
  container.innerHTML = "";

  if (!parcels.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.display = "grid";
    empty.textContent = "Aucune parcelle enregistrée.";
    container.appendChild(empty);
    return;
  }

  parcels.forEach(parcel => {
    const item = document.createElement("div");
    item.className = "parcel-item";

    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${parcel.exploitation} — ${parcel.name}`;
    const details = document.createElement("span");
    details.textContent = parcel.variety;
    info.append(title, details);

    const area = document.createElement("span");
    area.className = "parcel-area";
    area.textContent = `${formatNumber(parcel.area_ha, 2)} ha`;

    item.append(info, area);
    container.appendChild(item);
  });
}

function exportCsv() {
  const parcel = selectedParcel();
  const records = filteredObservations();
  if (!parcel) return;

  const rows = [
    ["Ravageur", "Année", "Exploitation", "Parcelle", "Variété", "Surface (ha)", "Date du relevé", "Captures"]
  ];

  records.forEach(record => {
    rows.push([
      PESTS[record.pest] || record.pest,
      record.observed_on.slice(0, 4),
      parcel.exploitation,
      parcel.name,
      parcel.variety,
      parcel.area_ha,
      record.observed_on,
      record.captures
    ]);
  });

  const csv = "\ufeff" + rows
    .map(row => row.map(escapeCsv).join(";"))
    .join("\r\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `sam_piegeage_${parcel.name.replaceAll(" ", "_")}_${el("yearSelect").value}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openParcelDialog() {
  setMessage(el("parcelMessage"));
  renderParcelList();
  el("parcelDialog").showModal();
}

function closeParcelDialog() {
  el("parcelDialog").close();
}

function bindEvents() {
  el("authForm").addEventListener("submit", signIn);
  el("signUpButton").addEventListener("click", signUp);
  el("signOutButton").addEventListener("click", signOut);

  el("addParcelButton").addEventListener("click", openParcelDialog);
  el("manageParcelsButton").addEventListener("click", openParcelDialog);
  el("closeParcelDialog").addEventListener("click", closeParcelDialog);
  el("parcelForm").addEventListener("submit", saveParcel);

  el("parcelDialog").addEventListener("click", event => {
    if (event.target === el("parcelDialog")) closeParcelDialog();
  });

  el("observationForm").addEventListener("submit", saveObservation);
  el("exportCsvButton").addEventListener("click", exportCsv);

  el("pestSelect").addEventListener("change", refreshDashboard);
  el("yearSelect").addEventListener("change", refreshDashboard);
  el("calculationSelect").addEventListener("change", refreshDashboard);
  el("displaySelect").addEventListener("change", refreshDashboard);

  el("farmSelect").addEventListener("change", () => {
    populateParcelFilter();
    refreshDashboard();
  });

  el("parcelSelect").addEventListener("change", refreshDashboard);
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  el("observationDate").value = new Date().toISOString().slice(0, 10);
  await bootstrap();
});
