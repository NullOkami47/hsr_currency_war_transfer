import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";

import rolesHandler from "../api/roles.mjs";
import searchHandler from "../api/search.mjs";
import transfersHandler from "../api/transfers.mjs";

const port = Number(process.env.PORT ?? 4173);
const publicDirectory = join(import.meta.dirname, "..", "public");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveFile(response, fileName) {
  const path = join(publicDirectory, fileName);
  try {
    const details = await stat(path);
    response.statusCode = 200;
    response.setHeader(
      "content-type",
      contentTypes.get(extname(path)) ?? "application/octet-stream",
    );
    response.setHeader(
      "cache-control",
      fileName.endsWith(".html") ? "no-cache" : "public, max-age=300",
    );
    response.setHeader("content-length", details.size);
    createReadStream(path).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/roles") {
    await rolesHandler(request, response);
    return;
  }
  if (url.pathname === "/api/search") {
    request.body = await readBody(request);
    await searchHandler(request, response);
    return;
  }
  if (url.pathname === "/api/transfers") {
    request.body = await readBody(request);
    await transfersHandler(request, response);
    return;
  }

  const staticRoutes = new Map([
    ["/", "index.html"],
    ["/showcase", "showcase.html"],
    ["/styles.css", "styles.css"],
    ["/app.js", "app.js"],
    ["/search-error.js", "search-error.js"],
    ["/theme-init.js", "theme-init.js"],
  ]);
  const fileName = staticRoutes.get(url.pathname);
  if (!fileName) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  await serveFile(response, fileName);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Currency War Transfer dev server: http://127.0.0.1:${port}`);
});
