import { handleError, rejectNonGet, sendJson } from "../lib/http.js";
import { openChargeMapKey } from "../lib/chargers.js";
import { providerKey } from "../lib/stations.js";

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    sendJson(res, 200, {
      ok: true,
      app: "TANKIQ",
      version: "1.3.0",
      providers: {
        fuel: {
          name: "Tankerkönig",
          configured: Boolean(providerKey()),
        },
        charging: {
          name: openChargeMapKey()
            ? "OpenChargeMap (OpenStreetMap fallback)"
            : "OpenStreetMap/Overpass",
          configured: true,
        },
      },
    }, "public, max-age=0, must-revalidate");
  } catch (error) {
    handleError(res, error);
  }
}
