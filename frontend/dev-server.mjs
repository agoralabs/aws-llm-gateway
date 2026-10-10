import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.FRONTEND_PORT ?? 4173);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const asset = files.get(url.pathname);
  if (!asset || request.method !== "GET") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(path.join(root, asset[0]));
    response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Unable to read frontend asset");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Gateway Lab ready at http://127.0.0.1:${port}`);
});
