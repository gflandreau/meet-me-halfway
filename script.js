"use strict";

const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go-btn");
const resultsWrap = document.getElementById("results-wrap");
const cardsEl = document.getElementById("cards");
const filtersEl = document.getElementById("filters");

let map;
let markerLayer;
let allPlaces = [];
let activeFilter = "all";

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

/* ---------- places (Overpass) ---------- */

// Pick a search radius (meters) based on how far apart the two people are.
function radiusFor(distApartKm) {
  if (distApartKm < 6) return 1500;
  if (distApartKm < 25) return 3000;
  return 5000;
}

const CATEGORY = {
  // amenity / leisure / tourism value -> our bucket
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

async function fetchPlaces(mid, radius) {
  const q = `[out:json][timeout:25];
(
  node["amenity"~"^(restaurant|fast_food|cafe|bar|pub|ice_cream|food_court|biergarten|cinema|theatre)$"](around:${radius},${mid.lat},${mid.lon});
  node["leisure"~"^(park|garden|bowling_alley)$"](around:${radius},${mid.lat},${mid.lon});
  node["tourism"~"^(museum|gallery|viewpoint|artwork|zoo|aquarium|attraction)$"](around:${radius},${mid.lat},${mid.lon});
);
out body 120;`;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error("Places lookup failed");
  const data = await res.json();

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

/* ---------- map ---------- */

function initMap(a, b, mid) {
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }
  markerLayer.clearLayers();

  const pin = (color, emoji) =>
    L.divIcon({
      className: "",
      html: `<div style="background:${color};width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 3px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;border:2px solid #fff"><span style="transform:rotate(45deg);font-size:14px">${emoji}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 28],
    });

  L.marker([a.lat, a.lon], { icon: pin("#ff4d9d", "📍") }).addTo(markerLayer).bindPopup("You 💗");
  L.marker([b.lat, b.lon], { icon: pin("#3a6ff0", "📍") }).addTo(markerLayer).bindPopup("Them 💙");
  L.marker([mid.lat, mid.lon], { icon: pin("#9b5de5", "✨") }).addTo(markerLayer).bindPopup("Your middle ✨");

  L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
    color: "#9b5de5", weight: 3, dashArray: "6 8", opacity: 0.7,
  }).addTo(markerLayer);

  map.fitBounds(
    L.latLngBounds([[a.lat, a.lon], [b.lat, b.lon]]).pad(0.3)
  );
  setTimeout(() => map.invalidateSize(), 200);
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
      .bindPopup(`${meta.emoji} <b>${p.name}</b><br>${p.distKm.toFixed(1)} km from middle`);
  });
}

/* ---------- rendering ---------- */

function render() {
  const list =
    activeFilter === "all"
      ? allPlaces
      : allPlaces.filter((p) => p.bucket === activeFilter);

  cardsEl.innerHTML = "";
  if (!list.length) {
    cardsEl.innerHTML = `<p class="empty">No spots in this category near your middle — try a wider category! 🌷</p>`;
    return;
  }

  list.slice(0, 30).forEach((p) => {
    const meta = LABELS[p.bucket];
    const details = [p.cuisine || p.kind, `${p.distKm.toFixed(1)} km from the middle`]
      .filter(Boolean)
      .join(" · ");
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=`;
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

/* ---------- main flow ---------- */

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q1 = document.getElementById("loc1").value.trim();
  const q2 = document.getElementById("loc2").value.trim();
  if (!q1 || !q2) return;

  goBtn.disabled = true;
  resultsWrap.hidden = true;
  setStatus("Finding both of you on the map… 🗺️");

  try {
    const [a, b] = await Promise.all([geocode(q1), geocode(q2)]);
    const mid = geoMidpoint(a, b);
    const apart = distanceKm(a, b);
    const radius = radiusFor(apart);

    setStatus(`You're ${apart.toFixed(1)} km apart. Searching the sweet spot in between… 💫`);

    resultsWrap.hidden = false;
    initMap(a, b, mid);

    allPlaces = await fetchPlaces(mid, radius);
    addPlaceMarkers(allPlaces.slice(0, 60));
    activeFilter = "all";
    [...filtersEl.children].forEach((c, i) => c.classList.toggle("chip--active", i === 0));
    render();

    if (allPlaces.length) {
      setStatus(`Found ${allPlaces.length} cute spots near ${a.label.split(",")[0]} & ${b.label.split(",")[0]}'s middle 💕`);
    } else {
      setStatus("Hmm, no spots found right in the middle — try two closer locations! 🌼", true);
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Something went wrong — try again 💔", true);
    resultsWrap.hidden = true;
  } finally {
    goBtn.disabled = false;
  }
});
