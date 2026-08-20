import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedFuelTypes,
  applyEvRangeConfirmation,
  applyRangeConfirmation,
  buildChargingEvent,
  buildFuelingEvent,
  deriveBatteryState,
  deriveTankState,
  estimatedChargeMinutes,
  evRangeEstimate,
  fullToFullElectricConsumption,
  fullToFullConsumption,
  isElectricProfile,
  nearestPricedStation,
  parseLocalizedNumber,
  plannedChargeKwh,
  plannedRefillLiters,
  rangeFreshness,
  rangeEstimate,
} from "../lib/tank-model.js";

test("petrol defaults safely to E5 and only adds E10 after confirmation", () => {
  assert.deepEqual(
    allowedFuelTypes({ vehicleFuel: "petrol", e10Compatible: false }),
    ["e5"],
  );
  assert.deepEqual(
    allowedFuelTypes({ vehicleFuel: "petrol", e10Compatible: true }),
    ["e5", "e10"],
  );
  assert.deepEqual(allowedFuelTypes({ vehicleFuel: "diesel" }), ["diesel"]);
});

test("fueling suggestion uses the nearest open station with a matching live price", () => {
  const station = nearestPricedStation(
    [
      {
        name: "Ohne E5",
        isOpen: true,
        distanceKm: 0.2,
        prices: { diesel: 1.6 },
      },
      { name: "Weiter", isOpen: true, distanceKm: 1.2, prices: { e5: 1.75 } },
      { name: "Näher", isOpen: true, distanceKm: 0.8, prices: { e5: 1.72 } },
    ],
    "e5",
  );
  assert.equal(station.name, "Näher");
  assert.equal(nearestPricedStation([], "e5"), null);
});

test("German decimal commas are accepted and invalid prices are rejected", () => {
  assert.equal(parseLocalizedNumber("1,699"), 1.699);
  assert.equal(parseLocalizedNumber(" 60,5 "), 60.5);
  const event = buildFuelingEvent({
    tankSize: 67,
    litersPurchased: "60,5",
    fullTank: false,
    missingLiters: "6,5",
    pricePerLiter: "1,699",
  });
  assert.equal(event.litersPurchased, 60.5);
  assert.equal(event.pricePerLiter, 1.699);
  assert.throws(
    () =>
      buildFuelingEvent({
        tankSize: 67,
        litersPurchased: 60,
        fullTank: false,
        missingLiters: 7,
        pricePerLiter: "abc",
      }),
    /gültigen Preis/,
  );
});

test("dashboard range confirmation updates liters and expires after movement or 24 hours", () => {
  const base = {
    liters: 60,
    asOf: "2026-08-20T08:00:00Z",
    source: "fueling-event",
    quality: "medium",
    event: { location: { lat: 50.9, lng: 7.18 } },
  };
  const state = applyRangeConfirmation({ tankSize: 67, cons: 8 }, base, {
    rangeKm: "420",
    timestamp: "2026-08-20T10:00:00Z",
    location: { lat: 50.9, lng: 7.18 },
  });
  assert.equal(state.liters, 33.6);
  assert.equal(state.source, "dashboard-range");
  assert.equal(
    rangeFreshness(
      state,
      { lat: 50.91, lng: 7.18 },
      { now: "2026-08-20T11:00:00Z" },
    ).fresh,
    true,
  );
  assert.equal(
    rangeFreshness(
      state,
      { lat: 51, lng: 7.18 },
      { now: "2026-08-20T11:00:00Z" },
    ).reason,
    "moved",
  );
  assert.equal(
    rangeFreshness(state, null, { now: "2026-08-21T11:00:01Z" }).reason,
    "age",
  );
});

test("partial fueling records purchase and post-fill level separately", () => {
  const event = buildFuelingEvent({
    tankSize: 67,
    litersPurchased: 60,
    fullTank: false,
    missingLiters: 7,
    pricePerLiter: 1.699,
    timestamp: "2026-08-20T12:00:00.000Z",
  });
  assert.equal(event.litersPurchased, 60);
  assert.equal(event.tankAfterLiters, 60);
  assert.equal(event.missingLiters, 7);
  assert.equal(event.totalCost, 101.94);
});

test("latest fueling event drives range and planned refill", () => {
  const profile = { tankSize: 67, cons: 8, reserveKm: 60, rangeQuality: "low" };
  const history = [
    {
      timestamp: "2026-08-20T12:00:00.000Z",
      tankAfterLiters: 60,
      fullTank: false,
    },
  ];
  const state = deriveTankState(profile, history);
  assert.equal(state.liters, 60);
  assert.equal(plannedRefillLiters(profile, state), 7);
  assert.equal(rangeEstimate(profile, state).raw, 750);
  assert.equal(rangeEstimate(profile, state).usable, 555);
});

test("legacy 60 liter entry remains a safe migration fallback", () => {
  const state = deriveTankState({ tankSize: 67, tankPct: 35, liters: 60 }, []);
  assert.equal(state.source, "legacy-liters");
  assert.equal(state.liters, 60);
  assert.equal(plannedRefillLiters({ tankSize: 67 }, state), 7);
});

test("full-to-full consumption includes intermediate partial fills", () => {
  const result = fullToFullConsumption([
    {
      timestamp: "2026-01-01T10:00:00Z",
      fullTank: true,
      odometerKm: 10000,
      litersPurchased: 50,
    },
    {
      timestamp: "2026-01-10T10:00:00Z",
      fullTank: false,
      odometerKm: 10400,
      litersPurchased: 20,
    },
    {
      timestamp: "2026-01-20T10:00:00Z",
      fullTank: true,
      odometerKm: 10800,
      litersPurchased: 40,
    },
  ]);
  assert.deepEqual(result, {
    liters: 60,
    distanceKm: 800,
    litersPer100Km: 7.5,
  });
});

test("electric profile derives battery state and planned charge", () => {
  const profile = {
    vehicleFuel: "electric",
    batteryCapacityKwh: 77,
    evCons: 19,
    targetSoc: 80,
    reserveKm: 40,
  };
  assert.equal(isElectricProfile(profile), true);
  const event = buildChargingEvent({
    batteryCapacityKwh: 77,
    energyAddedKwh: "32,5",
    pricePerKwh: "0,59",
    socAfter: 70,
    durationMinutes: 28,
    timestamp: "2026-08-20T12:00:00Z",
  });
  assert.equal(event.batteryAfterKwh, 53.9);
  assert.equal(event.totalCost, 19.175);
  const state = deriveBatteryState(profile, [event]);
  assert.equal(Math.round(plannedChargeKwh(profile, state) * 10) / 10, 7.7);
  assert.equal(Math.round(evRangeEstimate(profile, state).raw), 284);
});

test("electric range confirmation and charge time stay conservative", () => {
  const profile = {
    batteryCapacityKwh: 77,
    evCons: 20,
    targetSoc: 80,
    reserveKm: 40,
  };
  const state = applyEvRangeConfirmation(
    profile,
    deriveBatteryState(profile, []),
    {
      rangeKm: 200,
      timestamp: "2026-08-20T12:00:00Z",
    },
  );
  assert.equal(state.kwh, 40);
  assert.equal(evRangeEstimate(profile, state).usable, 144);
  assert.ok(estimatedChargeMinutes(40, 150, 100, 80) > 31);
});

test("electric full-to-full history calculates measured consumption", () => {
  const result = fullToFullElectricConsumption([
    {
      timestamp: "2026-01-01T10:00:00Z",
      socAfter: 100,
      odometerKm: 10000,
      energyAddedKwh: 40,
    },
    {
      timestamp: "2026-01-10T10:00:00Z",
      socAfter: 60,
      odometerKm: 10300,
      energyAddedKwh: 30,
    },
    {
      timestamp: "2026-01-20T10:00:00Z",
      socAfter: 100,
      odometerKm: 10500,
      energyAddedKwh: 60,
    },
  ]);
  assert.deepEqual(result, { kwh: 90, distanceKm: 500, kwhPer100Km: 18 });
});
