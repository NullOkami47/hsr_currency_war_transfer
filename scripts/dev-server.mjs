import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";

import rolesHandler from "../api/roles.mjs";
import searchHandler from "../api/search.mjs";
import transfersHandler from "../api/transfers.mjs";
import adminHandler from "../api/admin/index.mjs";
import adminSessionHandler from "../api/admin/session.mjs";

const port = Number(process.env.PORT ?? 4173);
const publicDirectory = join(import.meta.dirname, "..", "public");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

async function readBody(request, maximumBytes = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("Request body is too large");
      error.status = 413;
      error.code = "body_too_large";
      throw error;
    }
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
  try {
    const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__local/health") {
    const instanceId = process.env.CURRENCY_WAR_LOCAL_INSTANCE_ID;
    if (instanceId) response.setHeader("x-currency-war-instance", instanceId);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
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
  if (url.pathname === "/api/admin/session") {
    if (["POST", "DELETE"].includes(request.method)) {
      request.body = await readBody(request);
    }
    await adminSessionHandler(request, response);
    return;
  }
  if (url.pathname === "/api/admin") {
    if (request.method === "PUT") request.body = await readBody(request);
    await adminHandler(request, response);
    return;
  }

  const staticRoutes = new Map([
    ["/", "index.html"],
    ["/showcase", "showcase.html"],
    ["/admin", "admin.html"],
    ["/admin.js", "admin.js"],
    ["/styles.css", "styles.css"],
    ["/app.js", "app.js"],
    ["/search-error.js", "search-error.js"],
    ["/theme-init.js", "theme-init.js"],
    ["/favicon.svg", "favicon.svg"],
  ]);
  const fileName = staticRoutes.get(url.pathname);
  if (!fileName) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
    await serveFile(response, fileName);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.statusCode = Number(error?.status) || 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({
      error: {
        code: error?.code ?? "internal_error",
        message: error?.status === 413
          ? "Request body is too large"
          : "The request could not be processed",
      },
    }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Currency War Transfer dev server: http://127.0.0.1:${port}`);
});
