import { handleError, rejectNonGet, sendJson } from "../lib/http.js";
import { getStations, providerKey } from "../lib/stations.js";

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    const keyConfigured = Boolean(providerKey());
    if (!keyConfigured) {
      sendJson(res, 503, { ok: false, stage: "provider", keyConfigured, error: "Provider nicht konfiguriert." });
      return;
    }
    const stations = await getStations({ lat: 47.7093, lng: 11.7582, radius: 5 });
    sendJson(res, 200, {
      ok: true,
      stage: "provider",
      keyConfigured,
      stationCount: stations.length,
      provider: "Tankerkönig",
      source: "MTS-K",
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    handleError(res, error);
  }
}
