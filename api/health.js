import { handleError, rejectNonGet, sendJson } from "../lib/http.js";
import { providerKey } from "../lib/stations.js";

export default async function handler(req, res) {
  try {
    rejectNonGet(req);
    sendJson(res, 200, {
      ok: true,
      app: "TANKIQ",
      version: "1.3.0",
      provider: "Tankerkönig",
      providerConfigured: Boolean(providerKey())
    }, "public, max-age=0, must-revalidate");
  } catch (error) {
    handleError(res, error);
  }
}
