import { createServer } from "node:http";

const port = Number(process.env.MOCK_WORKER_PORT ?? 8789);
const token = process.env.MOCK_WORKER_TOKEN ?? "qa-worker-token";
let polls = 0;

createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { code: "unauthorised" } }));
    return;
  }
  if (request.method === "POST" && request.url === "/jobs") {
    response.statusCode = 202;
    response.end(JSON.stringify({ status: "queued", jobId: "qa-job" }));
    return;
  }
  if (request.method === "GET" && request.url === "/jobs/qa-job") {
    polls += 1;
    response.statusCode = 200;
    response.end(JSON.stringify(polls < 2
      ? { status: "queued", jobId: "qa-job" }
      : {
          status: "partial",
          jobId: "qa-job",
          globalId: "6a6c694a2a5c4702d0b47b26",
          shareCode: "QA-GLOBAL-CODE=",
          ignored: [{ type: "role", id: "9999", reason: "unavailable" }],
        }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { code: "not_found" } }));
}).listen(port, "127.0.0.1");
