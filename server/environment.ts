import { networkInterfaces } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Shell values take precedence; .env.local overrides .env for server settings too.
const fileEnvironment = Object.assign(
  {},
  ...[".env", ".env.local"].map((file) =>
    existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {},
  ),
);
for (const [key, value] of Object.entries(fileEnvironment)) {
  if (process.env[key] === undefined) process.env[key] = value as string;
}

export function publicOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a complete HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTPS origin without a path, query, or credentials.",
    );
  return url.origin;
}

export const WEB_PORT = 5173;
export const SIGNAL_PORT = 3001;
export const certPath = resolve(".certs/dev-cert.pem");
export const keyPath = resolve(".certs/dev-key.pem");

export function lanAddresses() {
  return Object.entries(networkInterfaces())
    .sort(
      ([a], [b]) => Number(!a.startsWith("en")) - Number(!b.startsWith("en")),
    )
    .flatMap(([, values]) => values ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

export function devEnvironment() {
  const addresses = lanAddresses();
  const host = process.env.LAN_HOST || addresses[0] || "localhost";
  const httpsReady = existsSync(certPath) && existsSync(keyPath);
  const externalOrigin = process.env.PUBLIC_ORIGIN
    ? publicOrigin(process.env.PUBLIC_ORIGIN)
    : undefined;
  const scheme = httpsReady ? "https" : "http";
  const origins = new Set(
    ["localhost", "127.0.0.1", "[::1]", host, ...addresses].flatMap(
      (address) => [
        `http://${address}:${WEB_PORT}`,
        `https://${address}:${WEB_PORT}`,
      ],
    ),
  );
  if (externalOrigin) origins.add(externalOrigin);
  return {
    httpsReady: Boolean(externalOrigin) || httpsReady,
    localHttpsReady: httpsReady,
    publicAccess: Boolean(externalOrigin),
    origins,
    inviteOrigin:
      externalOrigin ??
      `${scheme}://${httpsReady ? host : "localhost"}:${WEB_PORT}`,
  };
}
