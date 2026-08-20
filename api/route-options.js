import { HttpError, handleError, numberParam, rejectNonGet, sendJson, textParam } from "../lib/http.js";
import { getStations } from "../lib/stations.js";
import {
  compactRoute,
  distanceToRouteKm,
  getRoute,
  getRouteMatrix,
  routeSampleIntervalKm,
  routeSamplesByDistance
} from "../lib/routing.js";

const FUELS = new Set(["diesel", "e10", "e5"]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function uniqueStations(groups) {
  const stations = new Map();
  for (const group of groups) {
    for (const station of group) stations.set(station.id, station);
  }
  return [...stations.values()];
}

function fallbackMatrix(baseRoute, candidates) {
  return candidates.map(candidate => {
    const detourKm = Math.max(0, candidate.routeDistanceKm * 2);
    return {
      distanceMeters: baseRoute.distance + detourKm * 1000,
      durationSeconds: baseRoute.duration + detourKm / 60 * 3600
    };
  });
}

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    const start = {
      lat: numberParam(req.query?.startLat, "startLat", { min: -90, max: 90 }),
      lng: numberParam(req.query?.startLng, "startLng", { min: -180, max: 180 })
    };
    const destination = {
      lat: numberParam(req.query?.destLat, "destLat", { min: -90, max: 90 }),
      lng: numberParam(req.query?.destLng, "destLng", { min: -180, max: 180 })
    };
    const fuel = textParam(req.query?.fuel ?? "diesel", "fuel", { min: 2, max: 10 }).toLowerCase();
    if (!FUELS.has(fuel)) {
      throw new HttpError(400, "INVALID_PARAMETER", "Ungültiger Kraftstoff.");
    }
    const liters = numberParam(req.query?.liters, "liters", { min: 1, max: 150, fallback: 45 });
    const consumption = numberParam(req.query?.cons, "cons", { min: 1, max: 40, fallback: 8 });
    const timeValue = numberParam(req.query?.timeValue, "timeValue", { min: 0, max: 250, fallback: 20 });
    const maxDetour = numberParam(req.query?.maxDetour, "maxDetour", { min: 1, max: 30, fallback: 8 });
    const usableRangeKm = numberParam(req.query?.usableRangeKm, "usableRangeKm", { min: 1, max: 2000, fallback: 180 });

    const baseRoute = await getRoute(start, destination);
    const distanceKm = baseRoute.distance / 1000;
    const durationMinutes = baseRoute.duration / 60;
    const coordinates = baseRoute.geometry.coordinates;
    const sampleIntervalKm = routeSampleIntervalKm(distanceKm);
    const corridorSampleCount = routeSamplesByDistance(coordinates, distanceKm, sampleIntervalKm).length;
    const destinationReachable = usableRangeKm >= distanceKm + maxDetour;
    const minimumStopDistance = Math.min(10, distanceKm / 2);
    const stopDistanceKm = destinationReachable
      ? Math.max(minimumStopDistance, distanceKm - Math.min(8, distanceKm / 2))
      : clamp(usableRangeKm * 0.8, minimumStopDistance, distanceKm);
    const stopPoints = routeSamplesByDistance(coordinates, distanceKm, Math.max(0.1, stopDistanceKm));
    const [stopLng, stopLat] = stopDistanceKm >= distanceKm
      ? coordinates.at(-1)
      : stopPoints[1] || coordinates.at(-1);
    const sampleRadiusKm = 25;
    let stopStations = null;
    let stopProviderError = null;
    try {
      stopStations = await getStations({
        lat: stopLat,
        lng: stopLng,
        radius: sampleRadiusKm,
        cacheTtlSeconds: 20 * 60,
        maxAgeMs: 20 * 60 * 1000
      });
    } catch (error) {
      stopProviderError = error;
    }

    const stationResults = stopStations
      ? [{ status: "fulfilled", value: stopStations }]
      : [{ status: "rejected", reason: stopProviderError }];
    const successfulGroups = stationResults
      .filter(result => result.status === "fulfilled")
      .map(result => result.value);
    const allStations = uniqueStations(successfulGroups);
    const routeForDistance = compactRoute(coordinates);

    const candidates = allStations
      .filter(station => station.isOpen && Number.isFinite(station.prices?.[fuel]))
      .map(station => ({
        ...station,
        price: station.prices[fuel],
        routeDistanceKm: distanceToRouteKm(station, routeForDistance)
      }))
      .filter(station => station.routeDistanceKm <= maxDetour + 3)
      .sort((a, b) => a.routeDistanceKm - b.routeDistanceKm || a.price - b.price)
      .slice(0, 20);

    let paths;
    let matrixFallback = false;
    if (candidates.length) {
      try {
        const matrix = await getRouteMatrix(start, candidates, destination);
        const destinationIndex = candidates.length + 1;
        paths = candidates.map((candidate, index) => {
          const stationIndex = index + 1;
          return {
            distanceMeters: matrix.distances[0][stationIndex] + matrix.distances[stationIndex][destinationIndex],
            durationSeconds: matrix.durations[0][stationIndex] + matrix.durations[stationIndex][destinationIndex]
          };
        });
      } catch {
        matrixFallback = true;
        paths = fallbackMatrix(baseRoute, candidates);
      }
    } else {
      paths = [];
    }

    const options = candidates.map((station, index) => {
      const detourKm = Math.max(0, (paths[index].distanceMeters - baseRoute.distance) / 1000);
      const detourMinutes = Math.max(0, (paths[index].durationSeconds - baseRoute.duration) / 60);
      const detourFuelCost = detourKm * consumption / 100 * station.price;
      const timeCost = detourMinutes / 60 * timeValue;
      const totalTripCost = station.price * liters + detourFuelCost + timeCost;
      return {
        station: {
          id: station.id,
          name: station.name,
          address: station.address,
          lat: station.lat,
          lng: station.lng,
          price: station.price
        },
        detourKm,
        detourMinutes,
        detourFuelCost,
        timeCost,
        totalTripCost
      };
    }).filter(option => option.detourKm <= maxDetour)
      .sort((a, b) => a.totalTripCost - b.totalTripCost);

    const referenceCost = options[0]?.totalTripCost ?? null;
    const rankedOptions = options.map(option => ({
      ...option,
      netAdvantage: referenceCost === null ? 0 : referenceCost - option.totalTripCost
    }));

    const sampleCount = 1;
    const partialProviderFailures = stationResults.filter(result => result.status === "rejected").length;
    const successfulSampleCount = sampleCount - partialProviderFailures;
    const coverageReliable = sampleCount > 0 && successfulSampleCount === sampleCount;
    const publishedOptions = coverageReliable ? rankedOptions : [];

    sendJson(res, 200, {
      ok: true,
      routingProvider: "OSRM",
      route: {
        distanceKm,
        durationMinutes,
        geometry: baseRoute.geometry,
        destination
      },
      meta: {
        sampleCount,
        sampleIntervalKm,
        corridorSampleCount,
        sampleRadiusKm,
        stationCount: allStations.length,
        candidateCount: candidates.length,
        eligibleCount: publishedOptions.length,
        successfulSampleCount,
        partialProviderFailures,
        coverageReliable,
        strategy: "next-stop-window",
        stopDistanceKm,
        stopWindowStartKm: Math.max(0, stopDistanceKm - sampleRadiusKm),
        stopWindowEndKm: Math.min(distanceKm, stopDistanceKm + sampleRadiusKm),
        destinationReachable,
        usableRangeKm,
        providerDeferred: Boolean(stopProviderError),
        liveSampleIndex: stopStations ? 0 : null,
        pendingSampleCount: partialProviderFailures,
        matrixFallback
      },
      reference: publishedOptions[0] ? {
        station: publishedOptions[0].station.name,
        totalTripCost: publishedOptions[0].totalTripCost
      } : null,
      options: publishedOptions
    });
  } catch (error) {
    handleError(res, error);
  }
}
