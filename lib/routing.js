import { HttpError, fetchJson } from "./http.js";

const EARTH_KM = 6371;

export function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function routeSamples(coordinates, count) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  const wanted = Math.max(2, Math.min(count, coordinates.length));
  return Array.from({ length: wanted }, (_, index) => {
    const pointIndex = Math.round(index * (coordinates.length - 1) / (wanted - 1));
    return coordinates[pointIndex];
  });
}

export function routeSampleIntervalKm(distanceKm) {
  if (distanceKm <= 200) return 10;
  if (distanceKm <= 500) return 20;
  return 50;
}

export function routeSamplesByDistance(coordinates, distanceKm, intervalKm = routeSampleIntervalKm(distanceKm)) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || distanceKm <= 0 || intervalKm <= 0) return [];

  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const [previousLng, previousLat] = coordinates[index - 1];
    const [lng, lat] = coordinates[index];
    cumulative.push(cumulative[index - 1] + haversineKm(previousLat, previousLng, lat, lng));
  }

  const geometryKm = cumulative.at(-1);
  if (!geometryKm) return [coordinates[0], coordinates.at(-1)];

  const targets = [];
  for (let target = 0; target < distanceKm; target += intervalKm) targets.push(target);
  if (targets.at(-1) !== distanceKm) targets.push(distanceKm);

  let segmentIndex = 1;
  return targets.map(targetKm => {
    const geometryTarget = targetKm / distanceKm * geometryKm;
    while (segmentIndex < cumulative.length - 1 && cumulative[segmentIndex] < geometryTarget) {
      segmentIndex += 1;
    }
    const segmentStart = cumulative[segmentIndex - 1];
    const segmentEnd = cumulative[segmentIndex];
    const ratio = segmentEnd === segmentStart ? 0 : (geometryTarget - segmentStart) / (segmentEnd - segmentStart);
    const [startLng, startLat] = coordinates[segmentIndex - 1];
    const [endLng, endLat] = coordinates[segmentIndex];
    return [
      startLng + (endLng - startLng) * ratio,
      startLat + (endLat - startLat) * ratio
    ];
  });
}

export function compactRoute(coordinates, maxPoints = 700) {
  if (coordinates.length <= maxPoints) return coordinates;
  return routeSamples(coordinates, maxPoints);
}

export function distanceToRouteKm(station, coordinates) {
  let nearest = Infinity;
  for (const [lng, lat] of coordinates) {
    nearest = Math.min(nearest, haversineKm(station.lat, station.lng, lat, lng));
  }
  return nearest;
}

export async function getRoute(start, destination) {
  const coordinates = start.lng + "," + start.lat + ";" + destination.lng + "," + destination.lat;
  const url = "https://router.project-osrm.org/route/v1/driving/" + coordinates + "?overview=full&geometries=geojson&steps=false";
  const data = await fetchJson(url, {
    timeoutMs: 18000,
    headers: { "User-Agent": "TANKIQ/1.3.0" }
  });
  const route = data.routes?.[0];
  if (!route?.geometry?.coordinates?.length) {
    throw new HttpError(502, "ROUTE_NOT_FOUND", "Keine Straßenroute gefunden.");
  }
  return route;
}

export async function getRouteMatrix(start, stations, destination) {
  const points = [start, ...stations, destination];
  const coordinates = points.map(point => point.lng + "," + point.lat).join(";");
  const url = "https://router.project-osrm.org/table/v1/driving/" + coordinates + "?annotations=distance,duration";
  const data = await fetchJson(url, {
    timeoutMs: 20000,
    headers: { "User-Agent": "TANKIQ/1.3.0" }
  });
  if (data.code !== "Ok" || !data.distances || !data.durations) {
    throw new HttpError(502, "ROUTE_MATRIX_FAILED", "Routenoptionen konnten nicht verglichen werden.");
  }
  return data;
}
