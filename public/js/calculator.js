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
const CYAN = "#22d3ee";

function baseMap(elId, center, zoom) {
  const map = L.map(elId, { center, zoom, zoomControl: true });
  L.tileLayer(ESRI_IMAGERY, { maxZoom: 19, attribution: ESRI_ATTR }).addTo(map);
  return map;
}

// ============================================================
// WA statewide parcels (WaTech "Current Parcels", all 39 counties).
// Free ArcGIS FeatureServer, CORS-enabled. Fetches outlines for the
// visible map area; acreage is computed geodesically from geometry.
// ============================================================
const WA_PARCELS_URL =
  "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0/query";
const PARCEL_MIN_ZOOM = 15;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function fetchParcels(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const params = new URLSearchParams({
    geometry: `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "PARCEL_ID_NR,SITUS_ADDRESS,SITUS_CITY_NM",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "400",
    f: "geojson",
  });
  const res = await fetch(`${WA_PARCELS_URL}?${params}`);
  const json = await res.json();
  return json.features || [];
}

// Adds clickable (or display-only) county parcel outlines to a map.
// onSelect receives { acres, address, city, feature } when interactive.
function parcelOverlay(map, { interactive = false, onSelect = null, onLoad = null } = {}) {
  const group = L.layerGroup().addTo(map);
  let selected = null;
  let selectedPid = null;
  let currentFeatures = [];

  const base = { color: CYAN, weight: 1.5, dashArray: "4 4", fillOpacity: 0.05 };
  const active = { color: CYAN, weight: 3, dashArray: null, fillOpacity: 0.28 };

  const load = debounce(async () => {
    if (map.getZoom() < PARCEL_MIN_ZOOM) {
      group.clearLayers();
      selected = null;
      currentFeatures = [];
      return;
    }
    let features;
    try {
      features = await fetchParcels(map.getBounds());
    } catch {
      return; // keep whatever's already drawn
    }
    group.clearLayers();
    selected = null;
    currentFeatures = features;
    for (const feature of features) {
      const layer = L.geoJSON(feature, { style: base });
      layer.feature = feature; // L.geoJSON doesn't retain the source feature
      if (interactive) {
        layer.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          selectParcelLayer(layer);
        });
      }
      group.addLayer(layer);
    }
    // Re-apply highlight after reload (tile refresh clears the old layer).
    if (selectedPid) {
      let done = false;
      group.eachLayer((l) => {
        if (!done && l.feature?.properties?.PARCEL_ID_NR === selectedPid) {
          selectParcelLayer(l, { silent: true });
          done = true;
        }
      });
    }
    if (onLoad) onLoad(features);
  }, 350);

  function selectParcelLayer(layer, { silent = false } = {}) {
    if (selected) selected.setStyle(base);
    selected = layer;
    selected.setStyle(active);
    selectedPid = layer.feature?.properties?.PARCEL_ID_NR || null;
    if (silent) return;
    const feature = layer.feature;
    const props = feature.properties || {};
    if (onSelect) {
      onSelect({
        acres: turf.area(feature) / SQ_M_PER_ACRE,
        address: props.SITUS_ADDRESS || "",
        city: props.SITUS_CITY_NM || "",
        feature,
      });
    }
  }

  // Select by source feature (matches on parcel id) — used by the nearby list.
  // Stops at first match: some parcels appear twice with different situs rows.
  function selectFeature(feature) {
    const pid = feature?.properties?.PARCEL_ID_NR;
    if (!pid) return;
    let done = false;
    group.eachLayer((l) => {
      if (!done && l.feature?.properties?.PARCEL_ID_NR === pid) {
        selectParcelLayer(l);
        done = true;
      }
    });
  }

  map.on("moveend", load);
  load();

  return { group, selectParcelLayer, selectFeature, getFeatures: () => currentFeatures };
}

// ============================================================
// Step 1 → geocode
// ============================================================
const addrInput = document.getElementById("address-input");
const addrError = document.getElementById("address-error");

// Census Bureau geocoder via our Cloudflare Pages Function (/api/geocode).
// Authoritative US address data — handles rural roads Nominatim misses.
// Only exists in the deployed site; returns 404 in local static dev.
async function geocodeViaCensus(address) {
  try {
    const res = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.match) return { ...json.match, query: address };
  } catch {}
  return null;
}

// Shared street parser for situs lookups: "2000 Rocky Mountain Way, ..." → ["2000", "ROCKY MOUNTAIN"]
function parseStreet(address) {
  const m = address.match(/^\s*(\d+[A-Za-z]?)\s+([^,]+)/);
  if (!m) return null;
  const num = m[1].toUpperCase();
  const street = m[2]
    .toUpperCase()
    .replace(/\b(ROAD|RD|STREET|ST|AVENUE|AVE|LANE|LN|DRIVE|DR|WAY|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|HIGHWAY|HWY|PLACE|PL|TERRACE|TER|LOOP)\b\.?/g, "")
    .replace(/\b(N|S|E|W|NE|NW|SE|SW)\b\.?$/, "")
    .trim()
    .replace(/'/g, "''");
  return street ? [num, street] : null;
}

// Kittitas County's own parcel database — freshest local addresses
// (has some the statewide layer misses, e.g. 390 Tillman Creek Rd).
const KITTITAS_SITUS_URL =
  "https://gis.co.kittitas.wa.us/kcgis/rest/services/COMPAS/TaxParcelQuery/MapServer/0/query";

async function geocodeViaCountySitus(address) {
  const parsed = parseStreet(address);
  if (!parsed) return null;
  const [num, street] = parsed;
  const params = new URLSearchParams({
    where: `UPPER(t2_Situs) LIKE '${num} ${street}%'`,
    outFields: "t2_Situs",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "1",
    f: "geojson",
  });
  try {
    const res = await fetch(`${KITTITAS_SITUS_URL}?${params}`);
    const json = await res.json();
    const f = json.features?.[0];
    if (!f) return null;
    const c = turf.center(f).geometry.coordinates;
    const label = (f.properties?.t2_Situs || address).replace(/\s+/g, " ").trim();
    return { lat: c[1], lng: c[0], label, query: address };
  } catch {}
  return null;
}

// WA statewide parcel situs-address lookup. Returns the exact parcel
// centroid — catches addresses the geocoders interpolate to the wrong lot,
// and confirms the property exists in county records.
async function geocodeViaParcelSitus(address) {
  const parsed = parseStreet(address);
  if (!parsed) return null;
  const [num, street] = parsed;
  const params = new URLSearchParams({
    where: `SITUS_ADDRESS LIKE '${num} ${street}%'`,
    outFields: "SITUS_ADDRESS,SITUS_CITY_NM",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "1",
    f: "geojson",
  });
  try {
    const res = await fetch(`${WA_PARCELS_URL}?${params}`);
    const json = await res.json();
    const f = json.features?.[0];
    if (!f) return null;
    const c = turf.center(f).geometry.coordinates;
    const p = f.properties || {};
    return {
      lat: c[1],
      lng: c[0],
      label: [p.SITUS_ADDRESS, p.SITUS_CITY_NM, "WA"].filter(Boolean).join(", "),
      query: address,
    };
  } catch {}
  return null;
}

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

// Exact match first via Census (through our proxy), then a progressive
// Nominatim fallback: full address → street+city → street+county → city.
// Rural roads are often missing from OSM, so we degrade to the nearest
// known area and let the user pin the exact spot on the satellite map.
async function geocode(address) {
  // County situs first — freshest local data, exact parcel centroid.
  const county = await geocodeViaCountySitus(address);
  if (county) return county;

  // Census Bureau — authoritative US addressing (via our proxy).
  const census = await geocodeViaCensus(address);
  if (census) return census;

  // Statewide parcel situs — covers the rest of Washington.
  const situs = await geocodeViaParcelSitus(address);
  if (situs) return situs;

  // Extract pieces: "2000 Rocky Mountain Way, Cle Elum, WA 98922"
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  const street = parts[0] || address;
  const city = parts[1] || "";
  const stateZip = parts[2] || "";
  const state = stateZip.replace(/[0-9]/g, "").trim();
  // Rural roads often match only without the house number.
  const streetNoNum = street.replace(/^\d+[A-Za-z]?\s+/, "");

  const queries = [address];
  if (city && state) queries.push(`${street}, ${city}, ${state}`);
  if (streetNoNum !== street) {
    if (city && state) queries.push(`${streetNoNum}, ${city}, ${state}`);
    if (state) queries.push(`${streetNoNum}, ${state}`);
  }
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

// Step 1 gate: name, phone, email are required to proceed to the estimate.
function validateContact() {
  const name = document.getElementById("contact-name").value.trim();
  const phone = document.getElementById("contact-phone").value.trim();
  const email = document.getElementById("contact-email").value.trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  if (!name) { setAddressError("Enter your name."); return null; }
  if (!phoneOk) { setAddressError("Enter a valid phone number (10+ digits)."); return null; }
  if (!emailOk) { setAddressError("Enter a valid email address."); return null; }
  state.contact = { name, phone, email };
  return state.contact;
}

// Normalize address input: collapse whitespace, default to WA.
function normalizeAddress(raw) {
  let q = raw.trim().replace(/\s+/g, " ");
  if (!/\b(WA|Washington)\b/i.test(q)) q += ", WA";
  return q;
}

document.getElementById("find-property").addEventListener("click", async () => {
  if (!validateContact()) return;
  const q = normalizeAddress(addrInput.value);
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
  state.searchCoords = [lat, lng];
  state.searchQuery = q;
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
  if (!validateContact()) return;
  // Default view: Cle Elum area. User pans/zooms and pins.
  state.address = "Pinned on map (no address entered)";
  state.coords = [47.1954, -120.9398];
  state.searchCoords = [47.1954, -120.9398];
  state.searchQuery = null;
  document.getElementById("confirm-address").textContent = state.address;
  showStep(2);
  initParcelMap(47.1954, -120.9398, 14);
});

// ============================================================
// Step 2: parcel confirm map
// ============================================================
let parcelMap = null;
let parcelPin = null;

let nearbyParcels = [];
let listBuiltFor = null;
let step2Overlay = null;

function initParcelMap(lat, lng, zoom = 18) {
  if (parcelMap) {
    parcelMap.setView([lat, lng], zoom);
    return;
  }
  parcelMap = baseMap("map-parcel", [lat, lng], zoom);

  parcelPin = L.marker([lat, lng]).addTo(parcelMap);
  selectParcel({ latlng: L.latLng(lat, lng), acres: null });

  step2Overlay = parcelOverlay(parcelMap, {
    interactive: true,
    onSelect: ({ acres, address, city, feature }) => {
      const center = turf.center(feature);
      const latlng = L.latLng(center.geometry.coordinates[1], center.geometry.coordinates[0]);
      parcelPin.setLatLng(latlng);
      selectParcel({ latlng, acres, address, city, feature });
      markActiveRow(feature?.properties?.PARCEL_ID_NR);
    },
    onLoad: (features) => {
      // Build the nearby list once per searched location (selection moves
      // state.coords, so key off the immutable search point instead).
      const key = state.searchCoords ? state.searchCoords.join(",") : null;
      if (!key || listBuiltFor === key) return;
      listBuiltFor = key;
      buildNearbyList(features);
    },
  });

  parcelMap.on("click", (e) => {
    parcelPin.setLatLng(e.latlng);
    selectParcel({ latlng: e.latlng, acres: null });
    markActiveRow(null);
  });
}

// Nearest parcels to the geocoded point, containing parcel first.
function buildNearbyList(features) {
  const pt = turf.point([state.searchCoords[1], state.searchCoords[0]]);
  // Prefer the parcel matching the searched address, then containing, then nearest.
  const wanted = parseStreet(state.searchQuery || "");
  nearbyParcels = features
    .map((f) => {
      const c = turf.center(f).geometry.coordinates;
      const situs = (f.properties?.SITUS_ADDRESS || "").toUpperCase();
      const addrMatch = wanted ? situs.startsWith(`${wanted[0]} ${wanted[1]}`) : false;
      return {
        f,
        center: c,
        dist: turf.distance(pt, turf.point(c), { units: "meters" }),
        contains: turf.booleanPointInPolygon(pt, f),
        addrMatch,
        acres: turf.area(f) / SQ_M_PER_ACRE,
        addr: f.properties?.SITUS_ADDRESS || "No situs address",
        city: f.properties?.SITUS_CITY_NM || "",
        pid: f.properties?.PARCEL_ID_NR || "",
      };
    })
    .filter((x) => x.dist <= 400)
    .sort((a, b) =>
      Number(b.addrMatch) - Number(a.addrMatch) ||
      Number(b.contains) - Number(a.contains) ||
      a.dist - b.dist
    );

  // Same parcel can appear twice with different situs rows — merge labels.
  const byPid = new Map();
  for (const x of nearbyParcels) {
    const existing = byPid.get(x.pid);
    if (existing) {
      if (!existing.addr.includes(x.addr)) existing.addr = `${existing.addr} / ${x.addr}`;
    } else {
      byPid.set(x.pid, x);
    }
  }
  nearbyParcels = [...byPid.values()].slice(0, 6);

  const box = document.getElementById("parcel-list-box");
  const ul = document.getElementById("parcel-list");
  ul.innerHTML = "";
  if (!nearbyParcels.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  nearbyParcels.forEach((x, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.pid = x.pid;
    btn.className =
      "w-full text-left px-4 py-2.5 rounded-md border border-forest-700 bg-forest-900 hover:border-forest-500 transition flex justify-between items-center gap-3";
    btn.innerHTML =
      `<span class="text-sm font-medium text-white">${escapeHtml(x.addr)}${x.city ? `, ${escapeHtml(x.city)}` : ""}</span>` +
      `<span class="text-xs text-stone-400 whitespace-nowrap">${x.acres.toFixed(2)} ac</span>`;
    btn.addEventListener("click", () => step2Overlay.selectFeature(x.f));
    li.appendChild(btn);
    ul.appendChild(li);
  });

  // Auto-select the containing parcel (or the nearest one).
  step2Overlay.selectFeature(nearbyParcels[0].f);
}

function markActiveRow(pid) {
  document.querySelectorAll("#parcel-list button").forEach((btn) => {
    const isActive = pid && btn.dataset.pid === pid;
    btn.classList.toggle("border-ember-400", !!isActive);
    btn.classList.toggle("bg-forest-800", !!isActive);
    btn.classList.toggle("border-forest-700", !isActive);
    btn.classList.toggle("bg-forest-900", !isActive);
  });
}

function selectParcel({ latlng, acres, address = "", city = "", feature = null }) {
  state.coords = [latlng.lat, latlng.lng];
  state.parcelAcres = acres;
  state.parcelFeature = feature;
  state.parcelAddress = [address, city].filter(Boolean).join(", ");
  const el = document.getElementById("confirm-parcel");
  if (acres) {
    const where = [address, city].filter(Boolean).join(", ");
    el.textContent = `Selected parcel${where ? `: ${where}` : ""} — about ${acres.toFixed(2)} acres (county data)`;
  } else {
    el.textContent = `Pinned at ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  }
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

  // County parcel outlines as drawing reference; selected parcel highlighted.
  parcelOverlay(drawMap, { interactive: false });
  if (state.parcelFeature) {
    L.geoJSON(state.parcelFeature, {
      style: { color: CYAN, weight: 3, dashArray: null, fillOpacity: 0.12 },
    }).addTo(drawMap);
  }

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
  // Contact info collected at step 1 rides along in the submission.
  if (state.contact) {
    document.getElementById("field-name").value = state.contact.name;
    document.getElementById("field-phone").value = state.contact.phone;
    document.getElementById("field-email").value = state.contact.email;
    document.getElementById("contact-summary").textContent =
      `Sending as ${state.contact.name} — ${state.contact.email}, ${state.contact.phone}`;
  }

  const parcelNote = state.parcelAcres
    ? `Parcel: ${state.parcelAddress}, ~${state.parcelAcres.toFixed(2)} ac (county data). `
    : "";
  document.getElementById("field-geometry").value =
    parcelNote +
    (state.drawnGeoJSON
      ? JSON.stringify(state.drawnGeoJSON)
      : `Manual acreage: ${state.acres} ac; coords: ${state.coords.join(",")}`);

  showStep(5);
});
