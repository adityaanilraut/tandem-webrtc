import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export async function serveFrontend(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
  path: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let file: string;
  if (path === "/" || path === "/room" || path.startsWith("/room/")) file = "index.html";
  else if (path === "/favicon.svg") file = "favicon.svg";
  else if (path.startsWith("/assets/")) {
    try {
      file = decodeURIComponent(path.slice(1));
    } catch {
      return false;
    }
    const assets = resolve(directory, "assets") + sep;
    if (
      !resolve(directory, file).startsWith(assets) ||
      file.includes("\\") ||
      file.includes("\0")
    )
      return false;
  } else return false;
  try {
    const content = await readFile(resolve(directory, file));
    response.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": file.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  } catch {
    return false;
  }
}
