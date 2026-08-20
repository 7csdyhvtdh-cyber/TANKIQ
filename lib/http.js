export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body, cacheControl = "no-store") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

export function rejectNonGet(req) {
  if (req.method && req.method !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Nur GET wird unterstützt.");
  }
}

export function numberParam(value, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_PARAMETER", "Ungültiger Parameter: " + name);
  }
  return parsed;
}

export function textParam(value, name, { min = 1, max = 200 } = {}) {
  const parsed = String(value ?? "").trim();
  if (parsed.length < min || parsed.length > max) {
    throw new HttpError(400, "INVALID_PARAMETER", "Ungültiger Parameter: " + name);
  }
  return parsed;
}

export async function fetchJson(url, { timeoutMs = 12000, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new HttpError(
      502,
      timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      timeout ? "Externer Dienst hat nicht rechtzeitig geantwortet." : "Externer Dienst ist nicht erreichbar."
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new HttpError(502, "INVALID_UPSTREAM_RESPONSE", "Externer Dienst lieferte keine gültigen Daten.");
  }

  if (!response.ok) {
    throw new HttpError(502, "UPSTREAM_ERROR", data?.message || data?.error || "Externer Dienst antwortete mit " + response.status + ".");
  }
  return data;
}

export function handleError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = error?.code || "INTERNAL_ERROR";
  const message = status < 500 && error?.message ? error.message : error instanceof HttpError ? error.message : "Unerwarteter Serverfehler.";
  if (status >= 500) console.error(code, error);
  sendJson(res, status, { ok: false, error: message, code });
}
