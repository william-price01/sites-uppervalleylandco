// Upper Valley Land Clearing — estimate wizard
// ============================================================
// OWNER: adjust the numbers below to match your actual pricing.
// Everything is computed client-side; nothing is sent anywhere
// until the visitor submits the lead form on the last step.
// ============================================================

const RATES = {
  // Base price per acre: moderate density, flat terrain, easy access.
  mulching: { label: "Forestry Mastication / Mulching", base: 1800 },
  fire: { label: "Fire Mitigation / Defensible Space", base: 1600 },
  clearing: { label: "Full Land Clearing", base: 2400 },
  brush: { label: "Brush & Blackberry Clearing", base: 1200 },
};

const DENSITY_MULT = { light: 0.7, moderate: 1.0, heavy: 1.45 };
const TERRAIN_MULT = { flat: 1.0, rolling: 1.15, steep: 1.35 };
const ACCESS_MULT = { easy: 1.0, moderate: 1.1, difficult: 1.25 };

// Volume discount on per-acre rate as job size grows.
function sizeFactor(acres) {
  if (acres < 1) return 1.2; // mobilization dominates on tiny jobs
  if (acres <= 5) return 1.0;
  if (acres <= 10) return 0.9;
  return 0.8;
}

const MIN_JOB = 1500; // minimum job charge ($)
const RANGE = 0.2; // output range: estimate ±20%
const SQ_M_PER_ACRE = 4046.8564224;

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function calculate({ service, acres, density, terrain, access }) {
  const rate = RATES[service];
  if (!rate || !(acres > 0)) return null;
  const perAcre =
    rate.base *
    (DENSITY_MULT[density] ?? 1) *
    (TERRAIN_MULT[terrain] ?? 1) *
    (ACCESS_MULT[access] ?? 1) *
    sizeFactor(acres);
  const mid = Math.max(perAcre * acres, MIN_JOB);
  const round = (n) => Math.round(n / 50) * 50;
  return { low: round(mid * (1 - RANGE)), high: round(mid * (1 + RANGE)) };
}

// ============================================================
// Wizard state
// ============================================================
const state = {
  step: 1,
  address: "",       // confirmed display address
  coords: null,      // [lat, lng]
  parcelAcres: null, // from parcel layer when available
  acres: 0,          // drawn (or manual) clearing area
  drawnGeoJSON: null,
  usingManual: false,
};

const TOTAL_STEPS = 5;
const stepEls = () => document.querySelectorAll(".wizard-step");

function showStep(n) {
  state.step = n;
  stepEls().forEach((el) => el.classList.toggle("hidden", +el.dataset.step !== n));
  const pct = Math.round((n / TOTAL_STEPS) * 100);
  document.getElementById("step-label").textContent = `Step ${n} of ${TOTAL_STEPS}`;
  document.getElementById("step-pct").textContent = `${pct}%`;
  document.getElementById("step-bar").style.width = `${pct}%`;
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Leaflet maps need a resize poke after their container is unhidden.
  if (n === 2 && parcelMap) setTimeout(() => parcelMap.invalidateSize(), 50);
  if (n === 3 && drawMap) setTimeout(() => drawMap.invalidateSize(), 50);
}

document.querySelectorAll(".btn-back").forEach((btn) =>
  btn.addEventListener("click", () => showStep(Math.max(1, state.step - 1)))
);

// ============================================================
// Map helpers
// ============================================================
const ESRI_IMAGERY =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTR =
  "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics";
const EMBER = "#e07b2a";

function baseMap(elId, center, zoom) {
  const map = L.map(elId, { center, zoom, zoomControl: true });
  L.tileLayer(ESRI_IMAGERY, { maxZoom: 19, attribution: ESRI_ATTR }).addTo(map);
  return map;
}

// ============================================================
// Step 1 → geocode
// ============================================================
const addrInput = document.getElementById("address-input");
const addrError = document.getElementById("address-error");

// Try a list of query strings against Nominatim, first hit wins.
async function tryNominatim(queries) {
  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`;
      const res = await fetch(url, { headers: { "User-Agent": "uppervalleylandclearing-estimate" } });
      const json = await res.json();
      if (json[0]) {
        return { lat: +json[0].lat, lng: +json[0].lon, label: json[0].display_name, query: q };
      }
    } catch {}
    // Nominatim usage policy: max 1 req/sec. Space the fallbacks.
    await new Promise((r) => setTimeout(r, 1100));
  }
  return null;
}

// Progressive fallback: full address → street+city → street+county → city.
// Rural roads are often missing from OSM, so we degrade to the nearest
// known area and let the user pin the exact spot on the satellite map.
function geocode(address) {
  // Extract pieces: "390 Tillman Creek Road, Cle Elum, WA 98922"
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  const street = parts[0] || address;
  const city = parts[1] || "";
  const stateZip = parts[2] || "";
  const state = stateZip.replace(/[0-9]/g, "").trim();

  const queries = [address];
  if (city && state) queries.push(`${street}, ${city}, ${state}`);
  // County helps when the city name isn't recognized (common for rural roads).
  if (city) queries.push(`${street}, ${city} County, ${state}`.replace(" County County", " County"));
  if (city && state) queries.push(`${city}, ${state}`);
  if (city) queries.push(city);
  queries.push(address.split(",")[0]); // bare street as last resort

  return tryNominatim(queries);
}

function setAddressError(msg) {
  addrError.textContent = msg || "";
  addrError.classList.toggle("hidden", !msg);
}

document.getElementById("find-property").addEventListener("click", async () => {
  const q = addrInput.value.trim();
  if (q.length < 3) {
    setAddressError("Enter an address or at least a town.");
    return;
  }
  setAddressError("");
  const btn = document.getElementById("find-property");
  btn.disabled = true;
  btn.textContent = "Searching…";
  const hit = await geocode(q);
  btn.disabled = false;
  btn.textContent = "Find My Property";

  // Always take them to the map. If we matched the exact address, great.
  // If we only matched the road / town, zoom out a bit and let them pin.
  // If nothing matched at all, drop them at Cle Elum and let them navigate.
  let lat, lng, zoom, label;
  if (hit) {
    lat = hit.lat; lng = hit.lng; label = hit.label;
    // Approximate match = we fell back past the full street address.
    const exact = hit.query === q || hit.query.startsWith(q.split(",")[0]);
    zoom = exact ? 18 : 15;
    if (!exact) {
      state._approxNotice = `We found <strong>${escapeHtml(hit.label)}</strong> — not the exact address. Zoom in and tap your property on the map.`;
    }
  } else {
    lat = 47.1954; lng = -120.9398; zoom = 13; label = q;
    state._approxNotice = "Couldn't locate that address — navigate the map and tap your property.";
  }
  state.address = label;
  state.coords = [lat, lng];
  document.getElementById("confirm-address").textContent = label;
  showStep(2);
  initParcelMap(lat, lng, zoom);

  // Show an approximate-match notice if we have one.
  const status = document.getElementById("parcel-status");
  if (state._approxNotice) {
    status.innerHTML = state._approxNotice;
    status.className = "mt-3 text-sm text-ember-300";
    state._approxNotice = null;
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("skip-address").addEventListener("click", () => {
  // Default view: Cle Elum area. User pans/zooms and pins.
  state.address = "Pinned on map (no address entered)";
  state.coords = [47.1954, -120.9398];
  document.getElementById("confirm-address").textContent = state.address;
  showStep(2);
  initParcelMap(47.1954, -120.9398, 14);
});

// ============================================================
// Step 2: parcel confirm map
// ============================================================
let parcelMap = null;
let parcelPin = null;

function initParcelMap(lat, lng, zoom = 18) {
  if (parcelMap) {
    parcelMap.setView([lat, lng], zoom);
    return;
  }
  parcelMap = baseMap("map-parcel", [lat, lng], zoom);

  parcelPin = L.marker([lat, lng]).addTo(parcelMap);
  selectParcel({ latlng: L.latLng(lat, lng), acres: null });

  parcelMap.on("click", (e) => {
    parcelPin.setLatLng(e.latlng);
    selectParcel({ latlng: e.latlng, acres: null });
  });
}

function selectParcel({ latlng, acres }) {
  state.coords = [latlng.lat, latlng.lng];
  state.parcelAcres = acres;
  const el = document.getElementById("confirm-parcel");
  el.textContent = acres
    ? `Selected parcel: about ${acres.toFixed(2)} acres (county data)`
    : `Pinned at ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  document.getElementById("confirm-parcel-btn").disabled = false;
}

document.getElementById("confirm-parcel-btn").addEventListener("click", () => {
  showStep(3);
  initDrawMap();
});

// ============================================================
// Step 3: draw clearing area
// ============================================================
let drawMap = null;
let drawnItems = null;

function initDrawMap() {
  // Zoom 18 is Esri's deepest reliable zoom in most areas; 19+ often blanks.
  if (drawMap) {
    drawMap.setView(state.coords, 18);
    return;
  }
  drawMap = baseMap("map-draw", state.coords, 18);
  L.marker(state.coords).addTo(drawMap);

  drawMap.createPane("drawPane");
  drawMap.getPane("drawPane").classList.add("draw-pane");

  drawnItems = new L.FeatureGroup({ pane: "drawPane" });
  drawMap.addLayer(drawnItems);

  const drawControl = new L.Control.Draw({
    position: "topleft",
    draw: {
      polygon: {
        allowIntersection: false,
        shapeOptions: { color: EMBER, weight: 3, fillOpacity: 0.25 },
        showArea: false,
      },
      polyline: false,
      rectangle: false,
      circle: false,
      circlemarker: false,
      marker: false,
    },
    edit: { featureGroup: drawnItems, edit: true, remove: true },
  });
  drawMap.addControl(drawControl);

  drawMap.on(L.Draw.Event.CREATED, (e) => {
    drawnItems.addLayer(e.layer);
    updateAcreage();
  });
  drawMap.on(L.Draw.Event.EDITED, updateAcreage);
  drawMap.on(L.Draw.Event.DELETED, updateAcreage);
}

function updateAcreage() {
  let total = 0;
  const features = [];
  drawnItems.eachLayer((layer) => {
    const gj = layer.toGeoJSON();
    features.push(gj);
    total += turf.area(gj);
  });
  state.acres = total / SQ_M_PER_ACRE;
  state.drawnGeoJSON = features.length
    ? { type: "FeatureCollection", features }
    : null;
  state.usingManual = false;

  document.getElementById("acres-display").textContent = state.acres.toFixed(2);
  document.getElementById("confirm-area-btn").disabled = state.acres <= 0.01;
}

// Manual acreage fallback
document.getElementById("manual-acreage").addEventListener("click", () => {
  document.getElementById("manual-acreage-box").classList.toggle("hidden");
});
document.getElementById("acres-manual").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  state.acres = v;
  state.usingManual = true;
  state.drawnGeoJSON = null;
  document.getElementById("acres-manual-out").textContent = `${v} ${v === 1 ? "acre" : "acres"}`;
  document.getElementById("acres-display").textContent = v.toFixed(2);
  document.getElementById("confirm-area-btn").disabled = false;
});

document.getElementById("confirm-area-btn").addEventListener("click", () => showStep(4));

// ============================================================
// Step 4 → 5: price + lead form
// ============================================================
const calcForm = document.getElementById("calc-form");

function estimateSummary(input, est) {
  const d = { light: "light vegetation", moderate: "moderate vegetation", heavy: "heavy vegetation" }[input.density];
  const t = { flat: "flat ground", rolling: "rolling terrain", steep: "steep terrain" }[input.terrain];
  const a = { easy: "easy access", moderate: "moderate access", difficult: "difficult access" }[input.access];
  const acresTxt = `${input.acres.toFixed(2)} acre${input.acres === 1 ? "" : "s"}`;
  return `${RATES[input.service].label} — ${acresTxt}, ${d}, ${t}, ${a}. Property: ${state.address}.`;
}

document.getElementById("get-price-btn").addEventListener("click", () => {
  const input = {
    service: calcForm.elements.service.value,
    acres: state.acres,
    density: calcForm.elements.density.value,
    terrain: calcForm.elements.terrain.value,
    access: calcForm.elements.access.value,
  };
  const est = calculate(input);
  if (!est) return;

  document.getElementById("calc-low").textContent = fmt.format(est.low);
  document.getElementById("calc-high").textContent = fmt.format(est.high);
  const summary = estimateSummary(input, est);
  document.getElementById("calc-summary").textContent = summary;

  // Carry into the lead form (owner sees estimate + map geometry in the email).
  document.getElementById("field-estimate").value =
    `${summary} Ballpark: ${fmt.format(est.low)}–${fmt.format(est.high)}.`;
  document.getElementById("field-geometry").value = state.drawnGeoJSON
    ? JSON.stringify(state.drawnGeoJSON)
    : `Manual acreage: ${state.acres} ac; coords: ${state.coords.join(",")}`;

  showStep(5);
});
