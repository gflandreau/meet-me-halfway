"use strict";

const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go-btn");
const resultsWrap = document.getElementById("results-wrap");
const cardsEl = document.getElementById("cards");
const filtersEl = document.getElementById("filters");
const waterNoteEl = document.getElementById("water-note");
const modeToggle = document.getElementById("mode-toggle");

let map;
let markerLayer;
let allPlaces = [];
let activeFilter = "all";
let midMode = "drive"; // "drive" = halfway along the driving route, "geo" = straight-line
let state = { a: null, b: null, radius: 2000 };

modeToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  midMode = btn.dataset.mode;
  [...modeToggle.children].forEach((c) => c.classList.toggle("mode-btn--active", c === btn));
});

/* ---------- helpers ---------- */

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

// Great-circle geographic midpoint of two lat/lon points.
function geoMidpoint(a, b) {
  const lat1 = toRad(a.lat), lon1 = toRad(a.lon);
  const lat2 = toRad(b.lat), lon2 = toRad(b.lon);
  const dLon = lon2 - lon1;
  const bx = Math.cos(lat2) * Math.cos(dLon);
  const by = Math.cos(lat2) * Math.sin(dLon);
  const lat3 = Math.atan2(
    Math.sin(lat1) + Math.sin(lat2),
    Math.sqrt((Math.cos(lat1) + bx) ** 2 + by ** 2)
  );
  const lon3 = lon1 + Math.atan2(by, Math.cos(lat1) + bx);
  return { lat: toDeg(lat3), lon: toDeg(lon3) };
}

// Haversine distance in km.
function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Format a kilometre distance as miles for display.
function mi(km) {
  return (km * 0.621371).toFixed(1);
}

/* ---------- geocoding (Nominatim) ---------- */

async function geocode(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!res.ok) throw new Error("Geocoding failed");
  const data = await res.json();
  if (!data.length) throw new Error(`Couldn't find "${query}" 😢`);
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    label: data[0].display_name.split(",").slice(0, 2).join(", "),
  };
}

// Point-in-polygon water test via Overpass is_in. Catches bays, lakes, and
// wide rivers that are mapped as filled areas. (Reverse-geocoding can't be
// trusted here — county/city boundaries often extend out over the water.)
async function isWaterPoint(pt) {
  const q = `[out:json][timeout:25];is_in(${pt.lat},${pt.lon})->.a;(area.a["natural"="water"];area.a["natural"="bay"];area.a["natural"="strait"];area.a["water"];);out tags;`;
  try {
    const data = await overpass(q);
    return (data.elements || []).length > 0;
  } catch {
    return false;
  }
}

/* ---------- driving route (OSRM) ---------- */

// Find the point that is halfway *by driving distance* along the road route
// between a and b. Returns { center, latlngs } or null if no route exists.
async function drivingMidpoint(a, b) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes || !data.routes.length) return null;

    const coords = data.routes[0].geometry.coordinates; // [lon, lat] pairs
    if (coords.length < 2) return null;

    // Cumulative distance along the route.
    let total = 0;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      total += distanceKm(
        { lat: coords[i - 1][1], lon: coords[i - 1][0] },
        { lat: coords[i][1], lon: coords[i][0] }
      );
      cum.push(total);
    }

    // Walk to the halfway distance and interpolate within that segment.
    const half = total / 2;
    let k = 1;
    while (k < cum.length && cum[k] < half) k++;
    const span = cum[k] - cum[k - 1] || 1;
    const f = (half - cum[k - 1]) / span;
    const lon = coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * f;
    const lat = coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * f;

    return {
      center: { lat, lon },
      latlngs: coords.map((c) => [c[1], c[0]]), // Leaflet wants [lat, lon]
    };
  } catch {
    return null;
  }
}

/* ---------- places (Overpass) ---------- */

// Search a generous ~10 mile radius around the middle so there are plenty of
// options to choose from.
const SEARCH_RADIUS_M = 16093; // 10 miles

const CATEGORY = {
  restaurant: "eat", fast_food: "eat", bar: "eat", pub: "eat",
  ice_cream: "eat", food_court: "eat", biergarten: "eat",
  cafe: "cafe",
  park: "date", garden: "date", museum: "date", gallery: "date",
  cinema: "date", theatre: "date", viewpoint: "date", artwork: "date",
  zoo: "date", aquarium: "date", attraction: "date", bowling_alley: "date",
};

const LABELS = {
  eat: { badge: "badge--eat", text: "Food & Drinks", emoji: "🍜" },
  cafe: { badge: "badge--cafe", text: "Café", emoji: "☕" },
  date: { badge: "badge--date", text: "Hangout", emoji: "🎡" },
};

// Public Overpass instances rate-limit / time out sometimes; fall back to a
// mirror before giving up.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query) });
      if (res.ok) return await res.json();
      lastErr = new Error("HTTP " + res.status);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass failed");
}

async function fetchPlaces(mid, radius) {
  const q = `[out:json][timeout:25];
(
  node["amenity"~"^(restaurant|fast_food|cafe|bar|pub|ice_cream|food_court|biergarten|cinema|theatre)$"](around:${radius},${mid.lat},${mid.lon});
  node["leisure"~"^(park|garden|bowling_alley)$"](around:${radius},${mid.lat},${mid.lon});
  node["tourism"~"^(museum|gallery|viewpoint|artwork|zoo|aquarium|attraction)$"](around:${radius},${mid.lat},${mid.lon});
);
out body 800;`;

  let data;
  try {
    data = await overpass(q);
  } catch {
    throw new Error("Couldn't load places right now — please try again in a moment 💔");
  }

  const seen = new Set();
  const places = [];
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    if (!tags.name) continue;
    const key = tags.amenity || tags.leisure || tags.tourism;
    const bucket = CATEGORY[key];
    if (!bucket) continue;
    if (seen.has(tags.name)) continue;
    seen.add(tags.name);

    const loc = { lat: el.lat, lon: el.lon };
    places.push({
      name: tags.name,
      bucket,
      kind: (key || "").replace(/_/g, " "),
      cuisine: tags.cuisine ? tags.cuisine.replace(/[_;]/g, " ") : "",
      lat: el.lat,
      lon: el.lon,
      distKm: distanceKm(mid, loc),
    });
  }
  places.sort((a, b) => a.distKm - b.distKm);
  return places;
}

// Prefer real towns/cities over tiny marinas, islands, and neighbourhoods when
// suggesting land alternatives. Lower rank = more substantial place.
const PLACE_RANK = {
  city: 0, town: 1, village: 2, suburb: 3, neighbourhood: 4, hamlet: 4, locality: 5,
};

// Find nearby populated places to offer as land alternatives when the
// midpoint lands on water. Ranked by a blend of distance and place size so the
// closest *meetable* town floats to the top.
async function nearestLandOptions(mid, radius) {
  const q = `[out:json][timeout:25];
(
  node["place"~"^(city|town|village|suburb|neighbourhood|hamlet|locality)$"](around:${radius},${mid.lat},${mid.lon});
);
out body 80;`;

  let data;
  try {
    data = await overpass(q);
  } catch {
    return [];
  }

  const seen = new Set();
  const opts = [];
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const rank = PLACE_RANK[tags.place] ?? 5;
    const distKm = distanceKm(mid, { lat: el.lat, lon: el.lon });
    opts.push({ name, lat: el.lat, lon: el.lon, distKm, score: distKm + rank * 3 });
  }
  // Cities/towns first (the +rank*3 penalty), but still favouring closer ones.
  opts.sort((a, b) => a.score - b.score);
  return opts.slice(0, 5);
}

/* ---------- map ---------- */

function pinIcon(color, emoji) {
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 3px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;border:2px solid #fff"><span style="transform:rotate(45deg);font-size:14px">${emoji}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
  });
}

function initMap() {
  if (map) return;
  map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

// Draw the "you / them / middle" pins around a center. If routeLatLngs is
// given, draw the real driving route; otherwise a straight dashed line.
function drawBase(center, routeLatLngs) {
  markerLayer.clearLayers();
  const a = state.a, b = state.b;

  L.marker([a.lat, a.lon], { icon: pinIcon("#ff4d9d", "📍") })
    .addTo(markerLayer).bindPopup("You 💗");
  L.marker([b.lat, b.lon], { icon: pinIcon("#3a6ff0", "📍") })
    .addTo(markerLayer).bindPopup("Them 💙");
  L.marker([center.lat, center.lon], { icon: pinIcon("#9b5de5", "💕") })
    .addTo(markerLayer)
    .bindPopup(
      center.name ? `Meet near ${center.name} 💕`
      : routeLatLngs ? "Your driving middle 🚗"
      : "Your middle 💕"
    );

  let bounds;
  if (routeLatLngs) {
    const line = L.polyline(routeLatLngs, { color: "#9b5de5", weight: 4, opacity: 0.75 })
      .addTo(markerLayer);
    bounds = line.getBounds();
  } else {
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color: "#9b5de5", weight: 3, dashArray: "6 8", opacity: 0.7,
    }).addTo(markerLayer);
    bounds = L.latLngBounds([[a.lat, a.lon], [b.lat, b.lon], [center.lat, center.lon]]);
  }

  map.fitBounds(bounds.pad(0.2));
  setTimeout(() => map.invalidateSize(), 150);
}

function addPlaceMarkers(places) {
  places.forEach((p) => {
    const meta = LABELS[p.bucket];
    L.circleMarker([p.lat, p.lon], {
      radius: 6,
      color: "#fff",
      weight: 2,
      fillColor: p.bucket === "eat" ? "#ff4d9d" : p.bucket === "cafe" ? "#ff7a59" : "#15d6a4",
      fillOpacity: 0.95,
    })
      .addTo(markerLayer)
      .bindPopup(`${meta.emoji} <b>${p.name}</b><br>${mi(p.distKm)} mi from middle`);
  });
}

/* ---------- water options UI ---------- */

function showWaterNote(options, activeName, heading) {
  if (!options.length) { waterNoteEl.hidden = true; return; }
  waterNoteEl.hidden = false;
  waterNoteEl.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = heading;
  waterNoteEl.appendChild(p);
  const wrap = document.createElement("div");
  wrap.className = "water-options";
  options.forEach((o) => {
    const btn = document.createElement("button");
    btn.className = "land-btn" + (o.name === activeName ? " land-btn--active" : "");
    btn.textContent = `${o.name} · ${mi(o.distKm)} mi`;
    btn.addEventListener("click", () => {
      [...wrap.children].forEach((c) => c.classList.toggle("land-btn--active", c === btn));
      setStatus(`Searching near ${o.name}… 💫`);
      loadAndRender(o);
    });
    wrap.appendChild(btn);
  });
  waterNoteEl.appendChild(wrap);
}

/* ---------- rendering ---------- */

function render() {
  const list =
    activeFilter === "all"
      ? allPlaces
      : allPlaces.filter((p) => p.bucket === activeFilter);

  cardsEl.innerHTML = "";
  if (!list.length) {
    cardsEl.innerHTML = `<p class="empty">No spots in this category nearby — try a wider category! 🌷</p>`;
    return;
  }

  list.slice(0, 48).forEach((p) => {
    const meta = LABELS[p.bucket];
    const details = [p.cuisine || p.kind, `${mi(p.distKm)} mi from the middle`]
      .filter(Boolean)
      .join(" · ");
    const mapHref = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}`;

    const card = document.createElement("article");
    card.className = "card card--" + p.bucket;
    card.innerHTML = `
      <span class="card__badge ${meta.badge}">${meta.emoji} ${meta.text}</span>
      <h3 class="card__name">${p.name}</h3>
      <p class="card__meta">${details}</p>
      <a class="card__link" href="${mapHref}" target="_blank" rel="noopener">View on map →</a>
    `;
    cardsEl.appendChild(card);
  });
}

filtersEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  [...filtersEl.children].forEach((c) => c.classList.toggle("chip--active", c === btn));
  render();
});

/* ---------- animated rainbow title ---------- */

const HEART_SVG =
  '<svg class="heart-svg" viewBox="0 0 32 29.6" aria-hidden="true"><path d="M23.6,0c-3.4,0-6.3,2.7-7.6,5.6C14.7,2.7,11.8,0,8.4,0C3.8,0,0,3.8,0,8.4c0,9.4,9.5,11.9,16,21.2c6.1-9.3,16-12,16-21.2C32,3.8,28.2,0,23.6,0z"/></svg>';

// Ordered rainbow, cycled across the letters.
const RAINBOW = [
  "#ff4d4d", "#ff7a1a", "#eaa400", "#36c46b", "#1aa7c0",
  "#3a6ff0", "#6b4ee6", "#a23ce0", "#ff4d9d",
];

// Build "meet me halfway" with ordered rainbow colors and an arched (curved) layout.
function buildTitle() {
  const el = document.getElementById("hero-title");
  if (!el) return;
  const chars = [..."meet me halfway"];
  const n = chars.length;
  el.textContent = "";

  let ci = 0;
  chars.forEach((ch, i) => {
    if (ch === " ") {
      el.appendChild(document.createTextNode(" "));
      return;
    }
    const span = document.createElement("span");
    span.className = "ltr";
    span.textContent = ch;
    span.style.color = RAINBOW[ci % RAINBOW.length];
    ci++;

    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0; // -1 (left) .. 1 (right)
    const lift = -(1 - t * t) * 18;              // hill: letters rise in the middle
    const angle = t * 18;                        // tilt to follow the curve
    span.style.transform = `translateY(${lift}px) rotate(${angle}deg)`;
    el.appendChild(span);
  });

  const heart = document.createElement("span");
  heart.className = "heart";
  heart.setAttribute("aria-hidden", "true");
  heart.innerHTML = HEART_SVG;
  el.appendChild(heart);
}

buildTitle();

/* ---------- main flow ---------- */

// Fetch + render everything around a chosen center.
async function loadAndRender(center, routeLatLngs) {
  drawBase(center, routeLatLngs);
  allPlaces = await fetchPlaces(center, state.radius);
  addPlaceMarkers(allPlaces.slice(0, 90));
  activeFilter = "all";
  [...filtersEl.children].forEach((c, i) => c.classList.toggle("chip--active", i === 0));
  render();

  const where = center.name ? `near ${center.name}` : "near your middle";
  if (allPlaces.length) {
    setStatus(`Found ${allPlaces.length} cute spots ${where} 💕`);
  } else {
    setStatus("Hmm, no spots found here — try another option or two closer locations 🌼", true);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q1 = document.getElementById("loc1").value.trim();
  const q2 = document.getElementById("loc2").value.trim();
  if (!q1 || !q2) return;

  goBtn.disabled = true;
  resultsWrap.hidden = true;
  waterNoteEl.hidden = true;
  setStatus("Finding both of you on the map… 🗺️");

  try {
    const [a, b] = await Promise.all([geocode(q1), geocode(q2)]);
    const apart = distanceKm(a, b);
    state = { a, b, radius: SEARCH_RADIUS_M };
    resultsWrap.hidden = false;
    initMap();

    const landRadius = Math.max(state.radius * 2, 15000);

    // Driving mode: meet halfway along the actual road route.
    if (midMode === "drive") {
      setStatus("Mapping the drive between you two… 🚗");
      const drive = await drivingMidpoint(a, b);
      if (drive) {
        waterNoteEl.hidden = true;
        await loadAndRender(drive.center, drive.latlngs);
        // Nothing right at the driving middle? Offer the nearest towns.
        if (!allPlaces.length) {
          const options = await nearestLandOptions(drive.center, landRadius);
          if (options.length) {
            showWaterNote(options, options[0].name,
              "🚗 nothing right at your driving middle! here are the closest towns — pick one:");
            await loadAndRender(options[0]);
          }
        }
        return;
      }
      setStatus("No drivable route between you two — using the straight-line middle instead 🛣️");
    }

    // Straight-line mode (also the driving fallback): geographic midpoint.
    const trueMid = geoMidpoint(a, b);

    // 1) Midpoint sits inside a mapped water body (bay / lake / wide river).
    if (await isWaterPoint(trueMid)) {
      setStatus("Your middle landed on water 🌊 Finding the closest land…");
      const options = await nearestLandOptions(trueMid, landRadius);
      if (options.length) {
        showWaterNote(options, options[0].name,
          "🌊 your exact middle landed on water! here are the closest spots on land — pick one:");
        await loadAndRender(options[0]);
        return;
      }
    }

    // 2) Otherwise search right at the midpoint.
    waterNoteEl.hidden = true;
    setStatus(`You're ${mi(apart)} mi apart. Searching the sweet spot in between… 💫`);
    await loadAndRender(trueMid);

    // 3) Fallback: nothing at the midpoint (open ocean or an empty area) —
    //    offer the nearest towns so there's always somewhere to meet.
    if (!allPlaces.length) {
      const options = await nearestLandOptions(trueMid, landRadius);
      if (options.length) {
        showWaterNote(options, options[0].name,
          "🌊 nothing right at your exact middle (water, or a quiet spot)! here are the closest towns — pick one:");
        await loadAndRender(options[0]);
      }
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Something went wrong — try again 💔", true);
    resultsWrap.hidden = true;
  } finally {
    goBtn.disabled = false;
  }
});
