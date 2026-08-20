import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 3000);

function adaptResponse(response) {
  return {
    statusCode: 200,
    setHeader(name, value) {
      response.setHeader(name, value);
    },
    end(body) {
      response.statusCode = this.statusCode;
      response.end(body);
    },
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost:" + port);
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5);
    if (!/^[a-z-]+$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const module = await import(
        pathToFileURL(path.join(root, "api", name + ".js"))
      );
      request.query = Object.fromEntries(url.searchParams);
      await module.default(request, adaptResponse(response));
    } catch (error) {
      console.error(error);
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ ok: false, error: "Lokaler Serverfehler." }),
      );
    }
    return;
  }

  const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
    ["/assets/tankiq-icon.svg", ["assets/tankiq-icon.svg", "image/svg+xml"]],
    ["/assets/tankiq-icon-180.png", ["assets/tankiq-icon-180.png", "image/png"]],
    ["/assets/tankiq-icon-192.png", ["assets/tankiq-icon-192.png", "image/png"]],
    ["/assets/tankiq-icon-512.png", ["assets/tankiq-icon-512.png", "image/png"]],
  ]);
  const asset = staticFiles.get(url.pathname);
  if (!asset) {
    response.writeHead(404).end("Not found");
    return;
  }
  const body = await readFile(path.join(root, asset[0]));
  response.writeHead(200, { "Content-Type": asset[1] });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log("TANKIQ 1.3.0 läuft auf http://127.0.0.1:" + port);
});
