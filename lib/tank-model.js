export const parseLocalizedNumber = (value) => {
  const normalized =
    typeof value === "string"
      ? value.trim().replace(/\s/g, "").replace(",", ".")
      : value;
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const finiteNumber = parseLocalizedNumber;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const distanceKm = (a, b) => {
  if (!a || !b) return null;
  const lat1 = finiteNumber(a.lat);
  const lng1 = finiteNumber(a.lng);
  const lat2 = finiteNumber(b.lat);
  const lng2 = finiteNumber(b.lng);
  if ([lat1, lng1, lat2, lng2].some((value) => value === null)) return null;
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

export function allowedFuelTypes(profile = {}) {
  if (profile.vehicleFuel === "diesel") return ["diesel"];
  return profile.e10Compatible === true ? ["e5", "e10"] : ["e5"];
}

export function isElectricProfile(profile = {}) {
  return profile.vehicleFuel === "electric";
}

export function nearestPricedStation(stations = [], fuel = "e5") {
  return (
    [...stations]
      .filter(
        (station) =>
          station?.isOpen &&
          Number.isFinite(Number(station?.distanceKm)) &&
          Number.isFinite(Number(station?.prices?.[fuel])),
      )
      .sort((a, b) => Number(a.distanceKm) - Number(b.distanceKm))[0] || null
  );
}

export function buildFuelingEvent(input) {
  const tankSize = finiteNumber(input.tankSize);
  const litersPurchased = finiteNumber(input.litersPurchased);
  const fullTank = Boolean(input.fullTank);
  const missingLiters = fullTank ? 0 : finiteNumber(input.missingLiters);

  if (!tankSize || tankSize <= 0)
    throw new Error("Die Tankgröße muss größer als 0 sein.");
  if (!litersPurchased || litersPurchased <= 0)
    throw new Error("Die getankte Menge muss größer als 0 sein.");
  if (litersPurchased > tankSize)
    throw new Error("Die getankte Menge kann nicht größer als der Tank sein.");
  if (
    !fullTank &&
    (missingLiters === null || missingLiters < 0 || missingLiters > tankSize)
  ) {
    throw new Error("Bitte die fehlenden Liter bis voll korrekt angeben.");
  }

  const pricePerLiter = finiteNumber(input.pricePerLiter);
  const priceWasEntered =
    input.pricePerLiter !== null &&
    input.pricePerLiter !== undefined &&
    String(input.pricePerLiter).trim() !== "";
  if (
    priceWasEntered &&
    (pricePerLiter === null || pricePerLiter <= 0 || pricePerLiter > 10)
  ) {
    throw new Error(
      "Bitte einen gültigen Preis pro Liter eingeben, z. B. 1,699.",
    );
  }
  const odometerKm = finiteNumber(input.odometerKm);
  const tankAfterLiters = fullTank ? tankSize : tankSize - missingLiters;
  const timestamp = input.timestamp || new Date().toISOString();

  return {
    id: input.id || `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    litersPurchased,
    pricePerLiter:
      pricePerLiter !== null && pricePerLiter > 0 ? pricePerLiter : null,
    totalCost:
      pricePerLiter !== null && pricePerLiter > 0
        ? litersPurchased * pricePerLiter
        : null,
    odometerKm: odometerKm !== null && odometerKm >= 0 ? odometerKm : null,
    fullTank,
    missingLiters,
    tankAfterLiters: clamp(tankAfterLiters, 0, tankSize),
    station: input.station || null,
    location: input.location || null,
  };
}

export function deriveTankState(profile, history = []) {
  const tankSize = Math.max(1, finiteNumber(profile.tankSize) || 70);
  const latest = [...history]
    .filter((event) => finiteNumber(event.tankAfterLiters) !== null)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  if (latest) {
    return {
      liters: clamp(Number(latest.tankAfterLiters), 0, tankSize),
      asOf: latest.timestamp,
      source: "fueling-event",
      quality: latest.fullTank ? "high" : "medium",
      event: latest,
    };
  }

  const legacyLiters = finiteNumber(profile.liters);
  const tankPercent = clamp(finiteNumber(profile.tankPct) ?? 35, 0, 100);
  return {
    liters: clamp(legacyLiters ?? (tankSize * tankPercent) / 100, 0, tankSize),
    asOf: null,
    source: legacyLiters !== null ? "legacy-liters" : "legacy-percent",
    quality: profile.rangeQuality || "medium",
    event: null,
  };
}

export function applyRangeConfirmation(profile, state, confirmation) {
  const rangeKm = finiteNumber(confirmation?.rangeKm);
  if (!confirmation?.timestamp || rangeKm === null || rangeKm < 0) return state;
  if (state?.asOf && new Date(confirmation.timestamp) < new Date(state.asOf))
    return state;
  const tankSize = Math.max(1, finiteNumber(profile.tankSize) || 70);
  const consumption = Math.max(0.1, finiteNumber(profile.cons) || 8);
  return {
    liters: clamp((rangeKm * consumption) / 100, 0, tankSize),
    asOf: confirmation.timestamp,
    source: "dashboard-range",
    quality: "high",
    event: state?.event || null,
    confirmation,
  };
}

export function rangeFreshness(state, currentLocation = null, options = {}) {
  if (!state?.asOf)
    return { fresh: false, reason: "missing", ageHours: null, movedKm: null };
  const now = options.now ? new Date(options.now) : new Date();
  const ageHours = Math.max(0, (now - new Date(state.asOf)) / 3_600_000);
  const maxAgeHours = finiteNumber(options.maxAgeHours) ?? 24;
  const sourceLocation =
    state.confirmation?.location || state.event?.location || null;
  const movedKm = distanceKm(sourceLocation, currentLocation);
  const moveThresholdKm = finiteNumber(options.moveThresholdKm) ?? 5;
  if (ageHours > maxAgeHours)
    return { fresh: false, reason: "age", ageHours, movedKm };
  if (movedKm !== null && movedKm > moveThresholdKm) {
    return { fresh: false, reason: "moved", ageHours, movedKm };
  }
  return { fresh: true, reason: "fresh", ageHours, movedKm };
}

export function plannedRefillLiters(profile, state) {
  const tankSize = Math.max(1, finiteNumber(profile.tankSize) || 70);
  return clamp(tankSize - (finiteNumber(state?.liters) || 0), 0, tankSize);
}

export function rangeEstimate(profile, state) {
  const consumption = Math.max(0.1, finiteNumber(profile.cons) || 8);
  const liters = Math.max(0, finiteNumber(state?.liters) || 0);
  const level = state?.quality || profile.rangeQuality || "medium";
  const uncertainty = level === "high" ? 0.08 : level === "low" ? 0.3 : 0.18;
  const reserveKm = Math.max(0, finiteNumber(profile.reserveKm) || 0);
  const raw = (liters / consumption) * 100;
  return {
    raw,
    usable: Math.max(0, raw * (1 - uncertainty) - reserveKm),
    level,
  };
}

export function fullToFullConsumption(history = []) {
  const chronological = [...history]
    .filter((event) => event?.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const fullIndexes = chronological
    .map((event, index) =>
      event.fullTank && finiteNumber(event.odometerKm) !== null ? index : -1,
    )
    .filter((index) => index >= 0);
  if (fullIndexes.length < 2) return null;

  const startIndex = fullIndexes.at(-2);
  const endIndex = fullIndexes.at(-1);
  const start = chronological[startIndex];
  const end = chronological[endIndex];
  const distanceKm = Number(end.odometerKm) - Number(start.odometerKm);
  if (distanceKm <= 0) return null;

  const interval = chronological.slice(startIndex + 1, endIndex + 1);
  if (interval.some((event) => finiteNumber(event.litersPurchased) === null))
    return null;
  const liters = interval.reduce(
    (sum, event) => sum + Number(event.litersPurchased),
    0,
  );
  return { liters, distanceKm, litersPer100Km: (liters / distanceKm) * 100 };
}

export function buildChargingEvent(input) {
  const batteryCapacityKwh = finiteNumber(input.batteryCapacityKwh);
  const energyAddedKwh = finiteNumber(input.energyAddedKwh);
  const socAfter = finiteNumber(input.socAfter);
  if (
    !batteryCapacityKwh ||
    batteryCapacityKwh < 5 ||
    batteryCapacityKwh > 250
  ) {
    throw new Error("Bitte eine gültige Batteriekapazität eingeben.");
  }
  if (
    !energyAddedKwh ||
    energyAddedKwh <= 0 ||
    energyAddedKwh > batteryCapacityKwh * 1.35
  ) {
    throw new Error("Bitte die geladene Energiemenge korrekt eingeben.");
  }
  if (socAfter === null || socAfter < 0 || socAfter > 100) {
    throw new Error(
      "Bitte den Ladestand nach dem Laden zwischen 0 und 100 % eingeben.",
    );
  }
  const pricePerKwh = finiteNumber(input.pricePerKwh);
  const priceWasEntered =
    input.pricePerKwh !== null &&
    input.pricePerKwh !== undefined &&
    String(input.pricePerKwh).trim() !== "";
  if (
    priceWasEntered &&
    (pricePerKwh === null || pricePerKwh <= 0 || pricePerKwh > 5)
  ) {
    throw new Error("Bitte einen gültigen Preis pro kWh eingeben, z. B. 0,59.");
  }
  const durationMinutes = finiteNumber(input.durationMinutes);
  if (
    durationMinutes !== null &&
    (durationMinutes < 0 || durationMinutes > 1440)
  ) {
    throw new Error("Bitte eine gültige Ladedauer in Minuten eingeben.");
  }
  const odometerKm = finiteNumber(input.odometerKm);
  const timestamp = input.timestamp || new Date().toISOString();
  return {
    id: input.id || `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    type: "charging-event",
    timestamp,
    energyAddedKwh,
    pricePerKwh: pricePerKwh !== null && pricePerKwh > 0 ? pricePerKwh : null,
    totalCost:
      pricePerKwh !== null && pricePerKwh > 0
        ? energyAddedKwh * pricePerKwh
        : null,
    durationMinutes: durationMinutes !== null ? durationMinutes : null,
    socAfter,
    batteryAfterKwh: clamp(
      (batteryCapacityKwh * socAfter) / 100,
      0,
      batteryCapacityKwh,
    ),
    odometerKm: odometerKm !== null && odometerKm >= 0 ? odometerKm : null,
    station: input.station || null,
    location: input.location || null,
  };
}

export function deriveBatteryState(profile, history = []) {
  const capacity = clamp(
    finiteNumber(profile.batteryCapacityKwh) || 60,
    5,
    250,
  );
  const latest = [...history]
    .filter((event) => finiteNumber(event.batteryAfterKwh) !== null)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  if (latest) {
    return {
      kwh: clamp(Number(latest.batteryAfterKwh), 0, capacity),
      soc: clamp(Number(latest.socAfter), 0, 100),
      asOf: latest.timestamp,
      source: "charging-event",
      quality: "high",
      event: latest,
    };
  }
  const soc = clamp(finiteNumber(profile.evSoc) ?? 60, 0, 100);
  return {
    kwh: (capacity * soc) / 100,
    soc,
    asOf: null,
    source: "profile-soc",
    quality: profile.rangeQuality || "medium",
    event: null,
  };
}

export function applyEvRangeConfirmation(profile, state, confirmation) {
  const rangeKm = finiteNumber(confirmation?.rangeKm);
  if (!confirmation?.timestamp || rangeKm === null || rangeKm < 0) return state;
  if (state?.asOf && new Date(confirmation.timestamp) < new Date(state.asOf))
    return state;
  const capacity = clamp(
    finiteNumber(profile.batteryCapacityKwh) || 60,
    5,
    250,
  );
  const consumption = Math.max(1, finiteNumber(profile.evCons) || 18);
  const kwh = clamp((rangeKm * consumption) / 100, 0, capacity);
  return {
    kwh,
    soc: (kwh / capacity) * 100,
    asOf: confirmation.timestamp,
    source: "dashboard-range",
    quality: "high",
    event: state?.event || null,
    confirmation,
  };
}

export function plannedChargeKwh(profile, state) {
  const capacity = clamp(
    finiteNumber(profile.batteryCapacityKwh) || 60,
    5,
    250,
  );
  const targetSoc = clamp(finiteNumber(profile.targetSoc) ?? 80, 1, 100);
  const current = clamp(finiteNumber(state?.kwh) || 0, 0, capacity);
  return clamp((capacity * targetSoc) / 100 - current, 0, capacity);
}

export function evRangeEstimate(profile, state) {
  const consumption = Math.max(1, finiteNumber(profile.evCons) || 18);
  const energy = Math.max(0, finiteNumber(state?.kwh) || 0);
  const level = state?.quality || profile.rangeQuality || "medium";
  const uncertainty = level === "high" ? 0.08 : level === "low" ? 0.3 : 0.18;
  const reserveKm = Math.max(0, finiteNumber(profile.reserveKm) || 0);
  const raw = (energy / consumption) * 100;
  return {
    raw,
    usable: Math.max(0, raw * (1 - uncertainty) - reserveKm),
    level,
  };
}

export function estimatedChargeMinutes(
  energyKwh,
  vehiclePowerKw,
  chargerPowerKw,
  targetSoc = 80,
) {
  const energy = Math.max(0, finiteNumber(energyKwh) || 0);
  if (!energy) return 0;
  const vehiclePower = Math.max(1, finiteNumber(vehiclePowerKw) || 50);
  const chargerPower = Math.max(
    1,
    finiteNumber(chargerPowerKw) || vehiclePower,
  );
  const taperFactor = Number(targetSoc) > 80 ? 0.62 : 0.76;
  return (energy / (Math.min(vehiclePower, chargerPower) * taperFactor)) * 60;
}

export function fullToFullElectricConsumption(history = []) {
  const chronological = [...history]
    .filter((event) => event?.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const fullIndexes = chronological
    .map((event, index) =>
      Number(event.socAfter) >= 99 && finiteNumber(event.odometerKm) !== null
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  if (fullIndexes.length < 2) return null;
  const startIndex = fullIndexes.at(-2);
  const endIndex = fullIndexes.at(-1);
  const start = chronological[startIndex];
  const end = chronological[endIndex];
  const distanceKm = Number(end.odometerKm) - Number(start.odometerKm);
  if (distanceKm <= 0) return null;
  const interval = chronological.slice(startIndex + 1, endIndex + 1);
  if (interval.some((event) => finiteNumber(event.energyAddedKwh) === null))
    return null;
  const kwh = interval.reduce(
    (sum, event) => sum + Number(event.energyAddedKwh),
    0,
  );
  return { kwh, distanceKm, kwhPer100Km: (kwh / distanceKm) * 100 };
}
