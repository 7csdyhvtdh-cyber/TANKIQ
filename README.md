# TANKIQ 1.3.0

TANKIQ unterstützt Tankentscheidungen mit Live-Kraftstoffpreisen, realen
Straßenrouten und einer Gesamtkostenbetrachtung.

## Entwicklung

- npm test
- npm run check
- npm run dev

Die Anwendung erwartet für Live-Kraftstoffpreise eine dieser
Vercel-Umgebungsvariablen: TANKERKOENIG_API_KEY, TANKERKOENIG_KEY,
TANKERKOENIG_APIKEY oder TANK_API_KEY.

## Endpunkte

- GET /api/health
- GET /api/diagnostics
- GET /api/stations?lat=…&lng=…&radius=…
- GET /api/geocode?q=…
- GET /api/route-options?startLat=…&startLng=…&destLat=…&destLng=…
