import { handleError, numberParam, rejectNonGet, sendJson } from "../lib/http.js";
import { getStations } from "../lib/stations.js";

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    const lat = numberParam(req.query?.lat, "lat", { min: -90, max: 90 });
    const lng = numberParam(req.query?.lng ?? req.query?.lon, "lng", { min: -180, max: 180 });
    const radius = numberParam(req.query?.radius, "radius", { min: 1, max: 25, fallback: 25 });
    const stations = await getStations({ lat, lng, radius });
    sendJson(res, 200, {
      ok: true,
      provider: "Tankerkönig",
      source: "MTS-K",
      fetchedAt: new Date().toISOString(),
      stations
    }, "public, s-maxage=60, stale-while-revalidate=300");
  } catch (error) {
    handleError(res, error);
  }
}
