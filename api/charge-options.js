import {
  handleError,
  numberParam,
  rejectNonGet,
  sendJson,
  textParam,
} from "../lib/http.js";
import { getChargers } from "../lib/chargers.js";
import { estimatedChargeMinutes } from "../lib/tank-model.js";
import {
  compactRoute,
  distanceToRouteKm,
  getRoute,
  getRouteMatrix,
  routeSampleIntervalKm,
  routeSamplesByDistance,
} from "../lib/routing.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function supportsConnector(charger, connector) {
  if (connector === "any" || !charger.connectors?.length) return true;
  const wanted =
    connector === "ccs" ? "ccs" : connector === "type2" ? "typ 2" : connector;
  return charger.connectors.some((value) =>
    String(value).toLowerCase().includes(wanted),
  );
}

function fallbackMatrix(baseRoute, candidates) {
  return candidates.map((candidate) => {
    const detourKm = Math.max(0, candidate.routeDistanceKm * 2);
    return {
      distanceMeters: baseRoute.distance + detourKm * 1000,
      durationSeconds: baseRoute.duration + (detourKm / 60) * 3600,
    };
  });
}

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    const start = {
      lat: numberParam(req.query?.startLat, "startLat", { min: -90, max: 90 }),
      lng: numberParam(req.query?.startLng, "startLng", {
        min: -180,
        max: 180,
      }),
    };
    const destination = {
      lat: numberParam(req.query?.destLat, "destLat", { min: -90, max: 90 }),
      lng: numberParam(req.query?.destLng, "destLng", { min: -180, max: 180 }),
    };
    const energyKwh = numberParam(req.query?.energyKwh, "energyKwh", {
      min: 0.1,
      max: 250,
      fallback: 30,
    });
    const consumption = numberParam(req.query?.evCons, "evCons", {
      min: 5,
      max: 80,
      fallback: 18,
    });
    const tariffPrice = numberParam(req.query?.tariffPrice, "tariffPrice", {
      min: 0.01,
      max: 5,
      fallback: 0.59,
    });
    const vehiclePowerKw = numberParam(
      req.query?.vehiclePowerKw,
      "vehiclePowerKw",
      { min: 2, max: 500, fallback: 100 },
    );
    const targetSoc = numberParam(req.query?.targetSoc, "targetSoc", {
      min: 1,
      max: 100,
      fallback: 80,
    });
    const timeValue = numberParam(req.query?.timeValue, "timeValue", {
      min: 0,
      max: 250,
      fallback: 20,
    });
    const maxDetour = numberParam(req.query?.maxDetour, "maxDetour", {
      min: 1,
      max: 30,
      fallback: 8,
    });
    const usableRangeKm = numberParam(
      req.query?.usableRangeKm,
      "usableRangeKm",
      { min: 1, max: 2000, fallback: 180 },
    );
    const connector = textParam(req.query?.connector || "ccs", "connector", {
      min: 3,
      max: 12,
    }).toLowerCase();

    const baseRoute = await getRoute(start, destination);
    const distanceKm = baseRoute.distance / 1000;
    const durationMinutes = baseRoute.duration / 60;
    const coordinates = baseRoute.geometry.coordinates;
    const sampleIntervalKm = routeSampleIntervalKm(distanceKm);
    const corridorSampleCount = routeSamplesByDistance(
      coordinates,
      distanceKm,
      sampleIntervalKm,
    ).length;
    const destinationReachable = usableRangeKm >= distanceKm + maxDetour;
    const minimumStopDistance = Math.min(10, distanceKm / 2);
    const stopDistanceKm = destinationReachable
      ? Math.max(minimumStopDistance, distanceKm - Math.min(8, distanceKm / 2))
      : clamp(usableRangeKm * 0.8, minimumStopDistance, distanceKm);
    const stopPoints = routeSamplesByDistance(
      coordinates,
      distanceKm,
      Math.max(0.1, stopDistanceKm),
    );
    const [stopLng, stopLat] =
      stopDistanceKm >= distanceKm
        ? coordinates.at(-1)
        : stopPoints[1] || coordinates.at(-1);
    const sampleRadiusKm = 25;
    const result = await getChargers({
      lat: stopLat,
      lng: stopLng,
      radius: sampleRadiusKm,
    });
    const routeForDistance = compactRoute(coordinates);
    const candidates = result.chargers
      .filter(
        (charger) =>
          charger.isOperational && supportsConnector(charger, connector),
      )
      .map((charger) => ({
        ...charger,
        routeDistanceKm: distanceToRouteKm(charger, routeForDistance),
      }))
      .filter((charger) => charger.routeDistanceKm <= maxDetour + 3)
      .sort(
        (a, b) =>
          a.routeDistanceKm - b.routeDistanceKm ||
          (b.maxPowerKw || 0) - (a.maxPowerKw || 0),
      )
      .slice(0, 20);

    let paths = [];
    let matrixFallback = false;
    if (candidates.length) {
      try {
        const matrix = await getRouteMatrix(start, candidates, destination);
        const destinationIndex = candidates.length + 1;
        paths = candidates.map((candidate, index) => {
          const chargerIndex = index + 1;
          return {
            distanceMeters:
              matrix.distances[0][chargerIndex] +
              matrix.distances[chargerIndex][destinationIndex],
            durationSeconds:
              matrix.durations[0][chargerIndex] +
              matrix.durations[chargerIndex][destinationIndex],
          };
        });
      } catch {
        matrixFallback = true;
        paths = fallbackMatrix(baseRoute, candidates);
      }
    }

    const options = candidates
      .map((charger, index) => {
        const detourKm = Math.max(
          0,
          (paths[index].distanceMeters - baseRoute.distance) / 1000,
        );
        const detourMinutes = Math.max(
          0,
          (paths[index].durationSeconds - baseRoute.duration) / 60,
        );
        const pricePerKwh = charger.pricePerKwh || tariffPrice;
        const chargeMinutes = estimatedChargeMinutes(
          energyKwh,
          vehiclePowerKw,
          charger.maxPowerKw || 22,
          targetSoc,
        );
        const chargingCost = energyKwh * pricePerKwh;
        const detourEnergyCost = ((detourKm * consumption) / 100) * tariffPrice;
        const timeCost = ((detourMinutes + chargeMinutes) / 60) * timeValue;
        return {
          charger: {
            id: charger.id,
            name: charger.name,
            address: charger.address,
            lat: charger.lat,
            lng: charger.lng,
            operator: charger.operator,
            maxPowerKw: charger.maxPowerKw,
            connectors: charger.connectors,
            numberOfPoints: charger.numberOfPoints,
            pricePerKwh,
            priceSource: charger.pricePerKwh ? "station" : "profile-tariff",
          },
          detourKm,
          detourMinutes,
          chargeMinutes,
          chargingCost,
          detourEnergyCost,
          timeCost,
          totalTripCost: chargingCost + detourEnergyCost + timeCost,
        };
      })
      .filter((option) => option.detourKm <= maxDetour)
      .sort((a, b) => a.totalTripCost - b.totalTripCost);

    sendJson(res, 200, {
      ok: true,
      routingProvider: "OSRM",
      chargingProvider: result.provider,
      route: {
        distanceKm,
        durationMinutes,
        geometry: baseRoute.geometry,
        destination,
      },
      meta: {
        sampleCount: 1,
        sampleIntervalKm,
        corridorSampleCount,
        sampleRadiusKm,
        chargerCount: result.chargers.length,
        candidateCount: candidates.length,
        eligibleCount: options.length,
        coverageReliable: true,
        pricingReliable: options.some(
          (option) => option.charger.priceSource === "station",
        ),
        strategy: "next-charge-window",
        stopDistanceKm,
        stopWindowStartKm: Math.max(0, stopDistanceKm - sampleRadiusKm),
        stopWindowEndKm: Math.min(distanceKm, stopDistanceKm + sampleRadiusKm),
        destinationReachable,
        usableRangeKm,
        matrixFallback,
      },
      options,
    });
  } catch (error) {
    handleError(res, error);
  }
}
