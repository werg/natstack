import * as esbuild from "esbuild";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "workspace/panels/terminal");
const outDir = path.join(root, ".tmp/terminal-input-jig");
const port = Number(process.env.PORT || 49321);

await fs.promises.mkdir(outDir, { recursive: true });
await fs.promises.copyFile(
  path.join(sourceDir, "inputJig.html"),
  path.join(outDir, "index.html")
);

await esbuild.build({
  entryPoints: [path.join(sourceDir, "inputJig.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: path.join(outDir, "inputJig.js"),
  loader: {
    ".css": "css",
  },
});

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

const server = http.createServer(async (req, res) => {
  try {
    const rawPath = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const pathname = rawPath === "/" ? "/index.html" : rawPath;
    const target = path.normalize(path.join(outDir, pathname));
    if (!target.startsWith(outDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const content = await fs.promises.readFile(target);
    res.writeHead(200, {
      "content-type": mime.get(path.extname(target)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Terminal input jig: http://127.0.0.1:${port}/`);
});
