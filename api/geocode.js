import { fetchJson, handleError, rejectNonGet, sendJson, textParam } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    const query = textParam(req.query?.q, "q", { min: 2, max: 120 });
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      countrycodes: "de",
      limit: "5",
      addressdetails: "0"
    });
    const data = await fetchJson("https://nominatim.openstreetmap.org/search?" + params, {
      timeoutMs: 12000,
      headers: {
        "User-Agent": "TANKIQ/1.3.0 (fuel decision web app)",
        "Accept-Language": "de"
      }
    });
    const results = (Array.isArray(data) ? data : []).map(item => ({
      name: item.display_name,
      lat: Number(item.lat),
      lng: Number(item.lon),
      type: item.type
    })).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng));
    sendJson(res, 200, { ok: true, provider: "OpenStreetMap/Nominatim", results }, "public, max-age=3600");
  } catch (error) {
    handleError(res, error);
  }
}
