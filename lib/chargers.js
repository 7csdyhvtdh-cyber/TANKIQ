import { fetchJson } from "./http.js";
import { haversineKm } from "./routing.js";

const memoryCache = new Map();

export function openChargeMapKey(env = process.env) {
  return env.OPENCHARGEMAP_API_KEY || env.OCM_API_KEY || "";
}

export function parsePowerKw(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/,/g, ".");
  const values = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0]),
  );
  if (!values.length) return null;
  let power = Math.max(...values);
  if (/\bw\b/i.test(text) && !/kw/i.test(text) && power > 1000) power /= 1000;
  return power > 0 && power <= 1000 ? power : null;
}

export function parsePricePerKwh(value) {
  if (!value) return null;
  const text = String(value).replace(/,/g, ".");
  const match = text.match(
    /(?:€|eur)?\s*(\d+(?:\.\d+)?)\s*(?:€|eur)?\s*(?:\/|pro)?\s*kwh/i,
  );
  if (!match) return null;
  const price = Number(match[1]);
  return price > 0 && price <= 5 ? price : null;
}

function connectorName(value = "") {
  const text = String(value).toLowerCase();
  if (text.includes("combo") || text.includes("ccs")) return "CCS";
  if (text.includes("chademo")) return "CHAdeMO";
  if (text.includes("tesla")) return "Tesla";
  if (
    text.includes("type 2") ||
    text.includes("typ 2") ||
    text.includes("type2")
  )
    return "Typ 2";
  return value ? String(value) : "Unbekannt";
}

export function normalizeOcmCharger(poi, origin = null) {
  const lat = Number(poi?.AddressInfo?.Latitude);
  const lng = Number(poi?.AddressInfo?.Longitude);
  const connections = Array.isArray(poi?.Connections) ? poi.Connections : [];
  const powers = connections
    .map((connection) => Number(connection?.PowerKW))
    .filter(Number.isFinite);
  const connectors = [
    ...new Set(
      connections
        .map((connection) => connectorName(connection?.ConnectionType?.Title))
        .filter(Boolean),
    ),
  ];
  const address = poi?.AddressInfo || {};
  return {
    id: "ocm-" + poi.ID,
    name: address.Title || poi?.OperatorInfo?.Title || "Ladepunkt",
    address: [address.AddressLine1, address.Postcode, address.Town]
      .filter(Boolean)
      .join(" "),
    lat,
    lng,
    distanceKm: origin ? haversineKm(origin.lat, origin.lng, lat, lng) : null,
    operator: poi?.OperatorInfo?.Title || "Unbekannter Betreiber",
    maxPowerKw: powers.length ? Math.max(...powers) : null,
    connectors,
    numberOfPoints:
      Number(poi?.NumberOfPoints) ||
      connections.reduce(
        (sum, connection) => sum + (Number(connection?.Quantity) || 1),
        0,
      ) ||
      1,
    isOperational: poi?.StatusType?.IsOperational !== false,
    status: poi?.StatusType?.Title || "Betriebsstatus unbekannt",
    pricePerKwh: parsePricePerKwh(poi?.UsageCost),
    priceText: poi?.UsageCost || null,
    dataSource: "OpenChargeMap",
  };
}

export function normalizeOsmCharger(element, origin = null) {
  const tags = element.tags || {};
  const lat = Number(element.lat ?? element.center?.lat);
  const lng = Number(element.lon ?? element.center?.lon);
  const socketKeys = Object.keys(tags).filter(
    (key) => key.startsWith("socket:") && !key.endsWith(":output"),
  );
  const connectors = [
    ...new Set(
      socketKeys
        .filter((key) => !["no", "0"].includes(String(tags[key]).toLowerCase()))
        .map((key) => connectorName(key.slice(7).replace(/_/g, " "))),
    ),
  ];
  const powerValues = [
    tags.max_power,
    tags.output,
    tags["charging_station:output"],
    ...Object.entries(tags)
      .filter(([key]) => key.startsWith("socket:") && key.endsWith(":output"))
      .map(([, value]) => value),
  ]
    .map(parsePowerKw)
    .filter(Number.isFinite);
  const statusText =
    tags.operational_status || tags.status || "Betriebsstatus unbekannt";
  const isOperational = !/closed|disused|construction|out.of.order/i.test(
    statusText,
  );
  const isPublic =
    !/^(private|no)$/i.test(String(tags.access || "")) &&
    !/nicht öffentlich|not public/i.test(
      String(tags.name || tags.operator || ""),
    );
  return {
    id: `osm-${element.type}-${element.id}`,
    name: tags.name || tags.operator || tags.brand || "Ladepunkt",
    address: [
      tags["addr:street"],
      tags["addr:housenumber"],
      tags["addr:postcode"],
      tags["addr:city"],
    ]
      .filter(Boolean)
      .join(" "),
    lat,
    lng,
    distanceKm: origin ? haversineKm(origin.lat, origin.lng, lat, lng) : null,
    operator: tags.operator || tags.brand || "Unbekannter Betreiber",
    maxPowerKw: powerValues.length ? Math.max(...powerValues) : null,
    connectors,
    numberOfPoints: Number(tags.capacity) || 1,
    isOperational,
    isPublic,
    status: statusText,
    pricePerKwh: parsePricePerKwh(tags.charge || tags.fee),
    priceText: tags.charge || null,
    dataSource: "OpenStreetMap",
  };
}

async function fromOpenChargeMap({ lat, lng, radius, key }) {
  const params = new URLSearchParams({
    output: "json",
    countrycode: "DE",
    latitude: String(lat),
    longitude: String(lng),
    distance: String(radius),
    distanceunit: "KM",
    maxresults: "100",
    compact: "false",
    verbose: "false",
  });
  const data = await fetchJson(
    "https://api.openchargemap.io/v3/poi/?" + params,
    {
      timeoutMs: 15000,
      headers: { "User-Agent": "TANKIQ/1.3.0", "X-API-Key": key },
    },
  );
  return data.map((poi) => normalizeOcmCharger(poi, { lat, lng }));
}

async function fromOpenStreetMap({ lat, lng, radius }) {
  const meters = Math.round(radius * 1000);
  const query = `[out:json][timeout:20];(node["amenity"="charging_station"](around:${meters},${lat},${lng});way["amenity"="charging_station"](around:${meters},${lat},${lng});relation["amenity"="charging_station"](around:${meters},${lat},${lng}););out center tags;`;
  const data = await fetchJson(
    "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(query),
    {
      timeoutMs: 25000,
      headers: { "User-Agent": "TANKIQ/1.3.0" },
    },
  );
  return (data.elements || []).map((element) =>
    normalizeOsmCharger(element, { lat, lng }),
  );
}

export async function getChargers({
  lat,
  lng,
  radius = 25,
  key = openChargeMapKey(),
}) {
  const cacheKey = [
    key ? "ocm" : "osm",
    Number(lat).toFixed(3),
    Number(lng).toFixed(3),
    Number(radius).toFixed(0),
  ].join(":");
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000)
    return cached.value;
  let chargers;
  let provider;
  if (key) {
    try {
      chargers = await fromOpenChargeMap({ lat, lng, radius, key });
      provider = "OpenChargeMap";
    } catch {
      chargers = await fromOpenStreetMap({ lat, lng, radius });
      provider = "OpenStreetMap/Overpass";
    }
  } else {
    chargers = await fromOpenStreetMap({ lat, lng, radius });
    provider = "OpenStreetMap/Overpass";
  }
  const normalized = chargers
    .filter(
      (charger) =>
        Number.isFinite(charger.lat) &&
        Number.isFinite(charger.lng) &&
        charger.isPublic !== false,
    )
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 200);
  const value = {
    chargers: normalized,
    provider,
    fetchedAt: new Date().toISOString(),
  };
  memoryCache.set(cacheKey, { value, fetchedAt: Date.now() });
  return value;
}
