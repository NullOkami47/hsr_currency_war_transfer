import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";

process.env.CURRENCY_WAR_WORKER_URL = "http://127.0.0.1:8789/jobs";
process.env.CURRENCY_WAR_WORKER_TOKEN = "qa-worker-token";

const { default: transfersHandler } = await import("../../api/transfers.mjs");
const publicDirectory = join(import.meta.dirname, "..", "..", "public");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, value) {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function file(response, name) {
  const path = join(publicDirectory, name);
  const details = await stat(path);
  response.statusCode = 200;
  response.setHeader("content-type", contentTypes.get(extname(path)));
  response.setHeader("content-length", details.size);
  createReadStream(path).pipe(response);
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname === "/api/roles") {
    json(response, { roles: [], version: "qa" });
    return;
  }
  if (url.pathname === "/api/search") {
    json(response, {
      mode: "direct",
      candidates: [{
        id: "6a56fe3021253d0e1a9f4761",
        title: "【QA】搜尋與轉移連接測試",
        description: "僅用於瀏覽器流程驗證，不會發布真實攻略。",
        author: { nickname: "QA" },
        roles: [],
        sourceUrl: "https://act.miyoushe.com/sr/event/currency-wars/index.html#/lineup/6a56fe3021253d0e1a9f4761",
      }],
      pageInfo: { scannedStrategies: 1, truncated: false },
    });
    return;
  }
  if (url.pathname === "/api/transfers") {
    request.body = await body(request);
    await transfersHandler(request, response);
    return;
  }

  const routes = new Map([
    ["/", "index.html"],
    ["/styles.css", "styles.css"],
    ["/app.js", "app.js"],
    ["/theme-init.js", "theme-init.js"],
  ]);
  const name = routes.get(url.pathname);
  if (name) {
    await file(response, name);
    return;
  }
  response.statusCode = 404;
  response.end("Not found");
}).listen(4173, "127.0.0.1");
