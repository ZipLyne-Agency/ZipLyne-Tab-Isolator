// A local HTTPS site that behaves like a cookie-login web app.
import { createHash } from "node:crypto";
import { createServer } from "node:https";

const session = (user) => [
  `sessionKey=${user}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  `__Host-sessionBinding=${user}-binding; Path=/; Secure; HttpOnly`,
  `lastActiveOrg=${user}-org; Path=/; Secure; Domain=localhost`
];
const expired = ["sessionKey=; Max-Age=0; Path=/; Secure; HttpOnly", "__Host-sessionBinding=; Max-Age=0; Path=/; Secure; HttpOnly"];
const page = (body) => `<!doctype html><title>Fake site</title><body>${body}</body>`;

export const ARTIFACT_SHORT_ID = "3FP9SaFPAY5Y2N8r97jYWX";
const ARTIFACT_UUID = "12345678-1234-4234-8234-123456789abc";
export const accessRequests = [];

export function startFakeSite({ key, cert, port }) {
  const sockets = [];
  const server = createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, "https://localhost");
    const cookie = request.headers.cookie ?? null;
    const user = url.searchParams.get("user");
    const json = (value, headers = {}) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": request.headers.origin ?? "*",
        "access-control-allow-credentials": "true",
        ...headers
      });
      response.end(JSON.stringify(value));
    };
    const html = (body, headers = {}) => {
      response.writeHead(200, { "content-type": "text/html", ...headers });
      response.end(page(body));
    };

    // Like Claude: the page itself says nothing until script has asked who you are.
    if (url.pathname === `/artifact/${ARTIFACT_SHORT_ID}`) {
      return html(`<script>
        fetch("/whoami").then((response) => response.json()).then(({ cookie }) => {
          document.title = (cookie ?? "").includes("sessionKey=alice") ? "Shared artifact" : "Page not found";
        });
      </script>`);
    }
    if (url.pathname === `/api/frame/${ARTIFACT_UUID}`) {
      accessRequests.push({ cookie, gate: request.headers["x-frame-cp"], org: url.searchParams.get("org") });
      const allowed = request.headers["x-frame-cp"] === "go"
        && (cookie ?? "").includes("sessionKey=alice")
        && url.searchParams.get("org") === "alice-org";
      response.writeHead(allowed ? 200 : 404, { "content-type": "application/json", "set-cookie": "probed=1; Path=/; Secure" });
      return response.end("{}");
    }

    switch (url.pathname) {
      case "/": return html('<a id="next" href="/second">next</a>');
      case "/second": return html("second page");
      // Private pages answer 200 and only say "not found" once script has run.
      case "/owned": return html(`<script>
        fetch("/whoami").then((response) => response.json()).then(({ cookie }) => {
          document.title = (cookie ?? "").includes("sessionKey=${url.searchParams.get("owner")}") ? "Shared doc" : "Page not found";
        });
      </script>`);
      case "/login": return json({ ok: user }, { "set-cookie": session(user) });
      case "/login-redirect":
        response.writeHead(302, { location: "/whoami", "set-cookie": session(user) });
        return response.end();
      case "/set-flag": return json({ ok: true }, { "set-cookie": `flag=${url.searchParams.get("value")}; Path=/; Secure` });
      case "/logout": return json({ ok: true }, { "set-cookie": expired });
      case "/whoami": return json({ cookie });
      case "/cached": return json({ cookie }, { "cache-control": "private, max-age=3600" });
      case "/etag": {
        if (request.headers["if-none-match"] === '"fixed"') {
          response.writeHead(304, { etag: '"fixed"' });
          return response.end();
        }
        return json({ cookie }, { etag: '"fixed"', "cache-control": "private, no-cache" });
      }
      case "/worker.js":
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end('onmessage = async () => postMessage(await (await fetch("/whoami")).json());');
      case "/sw.js":
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end("addEventListener('install',()=>skipWaiting());addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('fetch',e=>e.respondWith(fetch(e.request)));");
      case "/push/sw.js":
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end("addEventListener('push',()=>{});");
      case "/sockets": return json(sockets);
      case "/favicon.ico":
        response.writeHead(204);
        return response.end();
      default:
        response.writeHead(404);
        return response.end();
    }
  });

  server.on("upgrade", (request, socket) => {
    sockets.push(request.headers.cookie ?? null);
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    setTimeout(() => socket.destroy(), 50);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve({ server, sockets }));
  });
}
