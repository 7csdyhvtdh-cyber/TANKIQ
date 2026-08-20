import test from "node:test";
import assert from "node:assert/strict";
import geocodeHandler from "../api/geocode.js";
import healthHandler from "../api/health.js";
import routeOptionsHandler from "../api/route-options.js";
import stationsHandler from "../api/stations.js";

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body || "";
    },
    json() {
      return JSON.parse(this.body);
    }
  };
}

test("health meldet Version 1.3.0", async () => {
  const response = responseCapture();
  await healthHandler({ method: "GET", query: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().version, "1.3.0");
});

test("stations lehnt ungültige Koordinaten vor Provider-Aufruf ab", async () => {
  const response = responseCapture();
  await stationsHandler({ method: "GET", query: { lat: "999", lng: "13", radius: "5" } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "INVALID_PARAMETER");
});

test("geocode normalisiert Nominatim-Antworten", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [{
      display_name: "Berlin, Deutschland",
      lat: "52.517",
      lon: "13.395",
      type: "administrative"
    }]
  });
  const response = responseCapture();
  await geocodeHandler({ method: "GET", query: { q: "Berlin" } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().results[0].name, "Berlin, Deutschland");
  assert.equal(response.json().provider, "OpenStreetMap/Nominatim");
});

test("API-Endpunkte lehnen POST ab", async () => {
  const response = responseCapture();
  await healthHandler({ method: "POST", query: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.json().code, "METHOD_NOT_ALLOWED");
});

test("Langstreckenroute empfiehlt den nächsten Reichweitenkorridor", async t => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TANKERKOENIG_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TANKERKOENIG_API_KEY;
    else process.env.TANKERKOENIG_API_KEY = originalKey;
  });
  process.env.TANKERKOENIG_API_KEY = "test-key";

  const routeCoordinates = Array.from({ length: 24 }, (_, index) => [11 + index * 0.1, 47 + index * 0.1]);
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.includes("/route/v1/")) {
      return {
        ok: true,
        json: async () => ({
          routes: [{
            distance: 600000,
            duration: 21600,
            geometry: { type: "LineString", coordinates: routeCoordinates }
          }]
        })
      };
    }
    if (target.includes("tankerkoenig")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          stations: [{
            id: "station-1",
            name: "Route Tankstelle",
            street: "Testweg",
            houseNumber: "1",
            postCode: "12345",
            place: "Testort",
            lat: 48.1,
            lng: 12.1,
            dist: 1,
            isOpen: true,
            diesel: 1.7,
            e10: 1.6,
            e5: 1.65
          }]
        })
      };
    }
    if (target.includes("/table/v1/")) {
      return {
        ok: true,
        json: async () => ({
          code: "Ok",
          distances: [
            [0, 300000, 600000],
            [300000, 0, 305000],
            [600000, 305000, 0]
          ],
          durations: [
            [0, 10000, 21600],
            [10000, 0, 12000],
            [21600, 12000, 0]
          ]
        })
      };
    }
    throw new Error("Unerwartete URL: " + target);
  };

  const response = responseCapture();
  await routeOptionsHandler({
    method: "GET",
    query: {
      startLat: "47",
      startLng: "11",
      destLat: "49.3",
      destLng: "13.3",
      fuel: "diesel",
      liters: "45",
      cons: "8",
      timeValue: "20",
      maxDetour: "8"
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().route.distanceKm, 600);
  assert.equal(response.json().meta.sampleIntervalKm, 50);
  assert.equal(response.json().meta.corridorSampleCount, 13);
  assert.equal(response.json().meta.sampleCount, 1);
  assert.equal(response.json().meta.strategy, "next-stop-window");
  assert.equal(response.json().meta.stopDistanceKm, 144);
  assert.equal(response.json().meta.successfulSampleCount, 1);
  assert.equal(response.json().meta.partialProviderFailures, 0);
  assert.equal(response.json().meta.coverageReliable, true);
  assert.equal(response.json().meta.liveSampleIndex, 0);
  assert.equal(response.json().options.length, 1);
  assert.equal(response.json().reference.station, "Route Tankstelle");
});
