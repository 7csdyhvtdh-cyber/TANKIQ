import test from "node:test";
import assert from "node:assert/strict";
import { HttpError, numberParam, textParam } from "../lib/http.js";
import { getCachedStations, getStations, normalizeStation, providerKey } from "../lib/stations.js";
import {
  compactRoute,
  haversineKm,
  routeSampleIntervalKm,
  routeSamples,
  routeSamplesByDistance
} from "../lib/routing.js";

test("numberParam validiert Grenzen und Fallbacks", () => {
  assert.equal(numberParam(undefined, "radius", { min: 1, max: 25, fallback: 8 }), 8);
  assert.equal(numberParam("12.5", "radius", { min: 1, max: 25 }), 12.5);
  assert.throws(
    () => numberParam("99", "radius", { min: 1, max: 25 }),
    error => error instanceof HttpError && error.status === 400
  );
});

test("textParam trimmt und begrenzt Eingaben", () => {
  assert.equal(textParam(" Berlin ", "q", { min: 2, max: 20 }), "Berlin");
  assert.throws(() => textParam("x", "q", { min: 2, max: 20 }), HttpError);
});

test("providerKey unterstützt bestehende Vercel-Varianten", () => {
  assert.equal(providerKey({ TANKERKOENIG_API_KEY: "one" }), "one");
  assert.equal(providerKey({ TANKERKOENIG_KEY: "two" }), "two");
  assert.equal(providerKey({}), "");
});

test("normalizeStation bildet Tankerkönig-Daten stabil ab", () => {
  const station = normalizeStation({
    id: "s1",
    name: "Test",
    street: "Musterweg",
    houseNumber: "4",
    postCode: 12345,
    place: "Berlin",
    lat: "52.5",
    lng: "13.4",
    dist: "1.2",
    isOpen: true,
    diesel: "1.699",
    e10: false,
    e5: null
  });
  assert.equal(station.address, "Musterweg 4 12345 Berlin");
  assert.equal(station.prices.diesel, 1.699);
  assert.equal(station.prices.e10, null);
  assert.equal(station.prices.e5, null);
});

test("Gebietscache deckt überlappende Korridorpunkte ab", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      stations: [{
        id: "cache-station",
        name: "Korridor Tankstelle",
        lat: 48.09,
        lng: 11,
        dist: 10,
        isOpen: true,
        diesel: 1.7,
        e10: 1.6,
        e5: 1.65
      }]
    })
  });

  await getStations({ lat: 48, lng: 11, radius: 25, key: "cache-test", cacheTtlSeconds: 1200 });
  const covered = await getCachedStations({ lat: 48.09, lng: 11, radius: 10, maxAgeMs: 20 * 60 * 1000 });
  assert.equal(covered.length, 1);
  assert.equal(covered[0].id, "cache-station");
});

test("Routenhelfer sampeln Endpunkte und berechnen Distanz", () => {
  const coordinates = [[11, 47], [12, 48], [13, 49], [14, 50], [15, 51]];
  assert.deepEqual(routeSamples(coordinates, 3), [[11, 47], [13, 49], [15, 51]]);
  assert.deepEqual(compactRoute(coordinates, 3), [[11, 47], [13, 49], [15, 51]]);
  assert.equal(Math.round(haversineKm(52.52, 13.405, 48.137, 11.575)), 504);
});

test("Routenkorridor verwendet streckenabhängige Abstände", () => {
  assert.equal(routeSampleIntervalKm(200), 10);
  assert.equal(routeSampleIntervalKm(201), 20);
  assert.equal(routeSampleIntervalKm(500), 20);
  assert.equal(routeSampleIntervalKm(501), 50);

  const coordinates = [[11, 47], [12, 47], [13, 47]];
  const samples = routeSamplesByDistance(coordinates, 100, 50);
  assert.equal(samples.length, 3);
  assert.deepEqual(samples[0], coordinates[0]);
  assert.deepEqual(samples.at(-1), coordinates.at(-1));
  assert.ok(Math.abs(samples[1][0] - 12) < 0.0001);
});
