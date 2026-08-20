import { HttpError, fetchJson } from "./http.js";
import { haversineKm } from "./routing.js";

const memoryCache = new Map();
const PROVIDER_INTERVAL_MS = 60 * 1000;

async function runtimeCache() {
  try {
    const { getCache } = await import("@vercel/functions");
    return getCache({ namespace: "tankiq-live-prices" });
  } catch {
    return null;
  }
}

async function cacheGet(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const value = await (await runtimeCache())?.get(key);
    if (value) memoryCache.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

async function cacheSet(key, value, ttl = 60) {
  memoryCache.set(key, value);
  try {
    await (await runtimeCache())?.set(key, value, {
      ttl,
      tags: ["tankiq-live-prices"],
      name: "tankiq-station-search"
    });
  } catch {
    // Cache failures must never suppress live data.
  }
}

function coveredBy(cached, lat, lng, radius, maxAgeMs = 65000) {
  if (!cached || Date.now() - cached.fetchedAt > maxAgeMs) return false;
  return haversineKm(cached.lat, cached.lng, lat, lng) + radius <= cached.radius;
}

function stationsForArea(stations, lat, lng, radius) {
  return stations.map(station => ({
    ...station,
    distanceKm: haversineKm(lat, lng, station.lat, station.lng)
  })).filter(station => station.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function fresh(cached, maxAgeMs) {
  return Boolean(cached?.stations && Date.now() - cached.fetchedAt <= maxAgeMs);
}

function searchKey(lat, lng, radius) {
  return "search:" + Number(lat).toFixed(4) + ":" + Number(lng).toFixed(4) + ":" + Number(radius).toFixed(1);
}

async function rememberSearch(entry, ttl) {
  const existing = await cacheGet("search-catalog");
  const now = Date.now();
  const catalog = (Array.isArray(existing) ? existing : [])
    .filter(item => item?.key !== entry.key && now - item.fetchedAt <= 20 * 60 * 1000);
  catalog.unshift(entry);
  await cacheSet("search-catalog", catalog.slice(0, 80), Math.max(ttl, 20 * 60));
}

export function providerKey(env = process.env) {
  return env.TANKERKOENIG_API_KEY
    || env.TANKERKOENIG_KEY
    || env.TANKERKOENIG_APIKEY
    || env.TANK_API_KEY
    || "";
}

export function normalizeStation(station) {
  const price = value => value === null || value === undefined || value === false
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    id: station.id,
    name: station.name || station.brand || "Tankstelle",
    address: [
      station.street,
      station.houseNumber,
      station.postCode,
      station.place
    ].filter(Boolean).join(" "),
    lat: Number(station.lat),
    lng: Number(station.lng),
    distanceKm: Number(station.dist),
    isOpen: Boolean(station.isOpen),
    prices: {
      diesel: price(station.diesel),
      e10: price(station.e10),
      e5: price(station.e5)
    }
  };
}

export async function getCachedStations({ lat, lng, radius = 25, maxAgeMs = 65000 }) {
  const exact = await cacheGet(searchKey(lat, lng, radius));
  if (fresh(exact, maxAgeMs)) return exact.stations;

  const lastSearch = await cacheGet("last-search");
  if (fresh(lastSearch, maxAgeMs) && coveredBy(lastSearch, lat, lng, radius, maxAgeMs)) {
    return stationsForArea(lastSearch.stations, lat, lng, radius);
  }

  const catalog = await cacheGet("search-catalog");
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!coveredBy(entry, lat, lng, radius, maxAgeMs)) continue;
    const cached = await cacheGet(entry.key);
    if (fresh(cached, maxAgeMs)) return stationsForArea(cached.stations, lat, lng, radius);
  }
  return null;
}

export async function getStations({
  lat,
  lng,
  radius = 25,
  key = providerKey(),
  cacheTtlSeconds = 60,
  maxAgeMs = cacheTtlSeconds * 1000 + 5000
}) {
  if (!key) {
    throw new HttpError(503, "PROVIDER_NOT_CONFIGURED", "Live-Preisanbieter ist nicht konfiguriert.");
  }

  const keyForSearch = searchKey(lat, lng, radius);
  const exact = await cacheGet(keyForSearch);
  if (fresh(exact, maxAgeMs)) {
    await rememberSearch({ key: keyForSearch, lat, lng, radius, fetchedAt: exact.fetchedAt }, cacheTtlSeconds);
    return exact.stations;
  }
  const cachedStations = await getCachedStations({ lat, lng, radius, maxAgeMs });
  if (cachedStations) return cachedStations;

  const lastProviderRequest = Number(await cacheGet("provider-last-request"));
  if (Number.isFinite(lastProviderRequest) && Date.now() - lastProviderRequest < PROVIDER_INTERVAL_MS) {
    throw new HttpError(429, "PROVIDER_RATE_LIMIT", "Der Livepreisanbieter erlaubt derzeit nur eine neue Gebietssuche pro Minute.");
  }
  await cacheSet("provider-last-request", Date.now(), 60);

  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    rad: String(radius),
    sort: "dist",
    type: "all",
    apikey: key
  });
  const data = await fetchJson("https://creativecommons.tankerkoenig.de/json/list.php?" + params, {
    timeoutMs: 12000,
    headers: { "User-Agent": "TANKIQ/1.3.0" }
  });

  if (!data.ok || !Array.isArray(data.stations)) {
    throw new HttpError(502, "PROVIDER_ERROR", data.message || "Livepreise konnten nicht geladen werden.");
  }

  const stations = data.stations
    .map(normalizeStation)
    .filter(station => Number.isFinite(station.lat) && Number.isFinite(station.lng));
  const cached = { lat, lng, radius, stations, fetchedAt: Date.now() };
  const catalogEntry = { key: keyForSearch, lat, lng, radius, fetchedAt: cached.fetchedAt };
  await Promise.all([
    cacheSet(keyForSearch, cached, cacheTtlSeconds),
    cacheSet("last-search", cached, cacheTtlSeconds),
    rememberSearch(catalogEntry, cacheTtlSeconds)
  ]);
  return stations;
}
