# TANKIQ 1.3.0

TANKIQ unterstützt Tank- und Ladeentscheidungen für Benzin-, Diesel- und
Elektrofahrzeuge. Die Anwendung kombiniert Kraftstoff-Livepreise bzw.
Ladepunktdaten mit realen Straßenrouten, Reichweite, Umweg, Ladezeit und einer
Gesamtkostenbetrachtung.

## Entwicklung

- npm test
- npm run check
- npm run dev

Die Anwendung erwartet für Live-Kraftstoffpreise eine dieser
Vercel-Umgebungsvariablen: TANKERKOENIG_API_KEY, TANKERKOENIG_KEY,
TANKERKOENIG_APIKEY oder TANK_API_KEY.

Ladepunkte werden ohne zusätzliche Konfiguration aus OpenStreetMap/Overpass
geladen. Optional kann `OPENCHARGEMAP_API_KEY` oder `OCM_API_KEY` gesetzt
werden; OpenStreetMap bleibt dann der Fallback. Da öffentliche Ladepreise oft
nicht maschinenlesbar vorliegen, verwendet TANKIQ in diesem Fall den im Profil
hinterlegten persönlichen Ladetarif.

## Endpunkte

- GET /api/health
- GET /api/diagnostics
- GET /api/stations?lat=…&lng=…&radius=…
- GET /api/chargers?lat=…&lng=…&radius=…
- GET /api/geocode?q=…
- GET /api/route-options?startLat=…&startLng=…&destLat=…&destLng=…
- GET /api/charge-options?startLat=…&startLng=…&destLat=…&destLng=…
