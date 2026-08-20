import {
  handleError,
  numberParam,
  rejectNonGet,
  sendJson,
} from "../lib/http.js";
import { getChargers } from "../lib/chargers.js";

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    const lat = numberParam(req.query?.lat, "lat", { min: -90, max: 90 });
    const lng = numberParam(req.query?.lng ?? req.query?.lon, "lng", {
      min: -180,
      max: 180,
    });
    const radius = numberParam(req.query?.radius, "radius", {
      min: 1,
      max: 50,
      fallback: 25,
    });
    const result = await getChargers({ lat, lng, radius });
    sendJson(
      res,
      200,
      {
        ok: true,
        provider: result.provider,
        source: "Ladepunkt-Stammdaten",
        fetchedAt: result.fetchedAt,
        priceBasis:
          "Stationspreis, sofern maschinenlesbar; sonst persönlicher Ladetarif",
        chargers: result.chargers,
      },
      "public, s-maxage=300, stale-while-revalidate=900",
    );
  } catch (error) {
    handleError(res, error);
  }
}
