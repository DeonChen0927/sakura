"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const routes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
]);
const port = Number(process.env.SAKURA_PREVIEW_PORT || 4178);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("SAKURA_PREVIEW_PORT must be an integer from 0 to 65535.");
  process.exit(1);
}
const server = http.createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }
  const route = routes.get(request.url.split("?")[0]);
  if (!route) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  fs.readFile(path.join(__dirname, route[0]), (error, data) => {
    if (error) {
      console.error(`Could not read preview file ${route[0]}: ${error.message}`);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Preview file could not be read.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": route[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    response.end(request.method === "HEAD" ? undefined : data);
  });
});
server.on("error", (error) => {
  console.error(`Sakura preview failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Sakura UI prototype: http://127.0.0.1:${server.address().port}`);
  console.log("Demo only. No credentials, external APIs, or persistent storage.");
});
