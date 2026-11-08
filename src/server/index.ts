/**
 * Bun server: serves the web client (bundled TS), the converted original assets,
 * and the WebSocket game server. Binds 0.0.0.0 and accepts the Arena preview host.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { GameServer } from "./gameServer.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BUILD = join(ROOT, "build");
const PORT = Number(process.env.PORT ?? 3000);

// 1. Ensure converted assets exist (generated from extracted/; git-ignored).
if (!existsSync(join(BUILD, "manifest.json"))) {
  console.log("[server] assets missing — running asset pipeline…");
  const proc = Bun.spawnSync(["bun", "run", join(ROOT, "tools", "asset-pipeline.ts")], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error("[server] asset pipeline failed");
    process.exit(1);
  }
}

// 2. Bundle the browser client.
console.log("[server] bundling client…");
const bundle = await Bun.build({
  entrypoints: [join(ROOT, "src", "client", "main.ts")],
  target: "browser",
  format: "esm",
  sourcemap: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!bundle.success) {
  console.error("[server] client bundle failed:", bundle.logs);
  process.exit(1);
}
const clientJS = await bundle.outputs[0]!.text();
const html = await Bun.file(join(ROOT, "src", "client", "index.html")).text();

const game = new GameServer();
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".js": "text/javascript",
  ".html": "text/html",
};

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("ws upgrade failed", { status: 400 });
    }
    if (path === "/" || path === "/index.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/client.js") {
      return new Response(clientJS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (path === "/manifest.json") {
      return new Response(Bun.file(join(BUILD, "manifest.json")), {
        headers: { "content-type": "application/json" },
      });
    }
    if (path.startsWith("/assets/")) {
      const file = Bun.file(join(BUILD, path));
      const ext = path.slice(path.lastIndexOf("."));
      return new Response(file, {
        headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "public, max-age=3600" },
      });
    }
    if (path === "/health") return new Response(JSON.stringify({ ok: true, online: game.onlineCount }));
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open: (ws) => game.open(ws),
    close: (ws) => game.close(ws),
    message: (ws, msg) => game.message(ws, msg),
  },
});

console.log(`[server] BnB TW web client listening on http://0.0.0.0:${server.port}`);