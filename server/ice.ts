import { createHmac, randomUUID } from "node:crypto";
import type { CallIceConfig } from "../shared/protocol";

const DEFAULT_STUN = "stun:stun.l.google.com:19302";
const CREDENTIAL_TTL = 3600;

export function createIceProvider(env: NodeJS.ProcessEnv = process.env) {
  const stun = env.STUN_URL ?? env.VITE_STUN_URL ?? DEFAULT_STUN;
  const urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (stun && !/^stuns?:[^\s]+$/.test(stun))
    throw new Error("STUN_URL must be a STUN URL.");
  if (urls.some((url) => !/^turns?:[^\s]+$/.test(url)))
    throw new Error(
      "TURN_URLS must contain comma-separated turn: or turns: URLs.",
    );
  const cloudflare = Boolean(
    env.CLOUDFLARE_TURN_KEY_ID || env.CLOUDFLARE_TURN_API_TOKEN,
  );
  if (
    cloudflare &&
    !(env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN)
  )
    throw new Error(
      "Set both CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN.",
    );
  if (
    cloudflare &&
    (urls.length || env.TURN_SECRET || env.TURN_USERNAME || env.TURN_PASSWORD)
  )
    throw new Error(
      "Choose Cloudflare TURN or TURN_URLS credentials, not both.",
    );
  const hasStaticCredentials = Boolean(env.TURN_USERNAME || env.TURN_PASSWORD);
  if (
    (urls.length || env.TURN_SECRET || hasStaticCredentials) &&
    !(
      urls.length &&
      (env.TURN_SECRET || (env.TURN_USERNAME && env.TURN_PASSWORD))
    )
  )
    throw new Error(
      "Set TURN_URLS and either TURN_SECRET or both TURN_USERNAME and TURN_PASSWORD.",
    );
  if (env.TURN_SECRET && hasStaticCredentials)
    throw new Error(
      "Choose TURN_SECRET or TURN_USERNAME/TURN_PASSWORD, not both.",
    );
  const turnConfigured = cloudflare || urls.length > 0;
  const policy = env.ICE_TRANSPORT_POLICY ?? "all";
  if (policy !== "all" && policy !== "relay")
    throw new Error("ICE_TRANSPORT_POLICY must be all or relay.");
  if (policy === "relay" && !turnConfigured)
    throw new Error("Relay-only mode requires a TURN service.");
  const base: RTCIceServer[] = stun ? [{ urls: stun }] : [];

  async function getConfiguration(): Promise<CallIceConfig> {
    const iceServers = [...base];
    if (cloudflare) {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID!)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: CREDENTIAL_TTL }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok)
        throw new Error("The TURN provider could not issue credentials.");
      const data: unknown = await response.json();
      const servers =
        data && typeof data === "object" && "iceServers" in data
          ? data.iceServers
          : null;
      if (!Array.isArray(servers) || !servers.length)
        throw new Error("The TURN provider returned no servers.");
      let hasRelay = false;
      for (const server of servers) {
        const values: unknown[] =
          typeof server?.urls === "string" ? [server.urls] : server?.urls;
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.some(
            (url) =>
              typeof url !== "string" ||
              !/^(stun|stuns|turn|turns):[^\s]+$/.test(url),
          )
        )
          throw new Error("The TURN provider returned invalid servers.");
        const relay = values.some((url) => /^turns?:/.test(String(url)));
        if (
          relay &&
          (typeof server.username !== "string" ||
            typeof server.credential !== "string")
        )
          throw new Error("The TURN provider returned invalid credentials.");
        hasRelay ||= relay;
        iceServers.push({
          urls: values as string[],
          ...(relay
            ? { username: server.username, credential: server.credential }
            : {}),
        });
      }
      if (!hasRelay)
        throw new Error("The TURN provider returned no relay servers.");
    } else if (urls.length) {
      const username = env.TURN_SECRET
        ? `${Math.floor(Date.now() / 1000) + CREDENTIAL_TTL}:${randomUUID()}`
        : env.TURN_USERNAME!;
      const credential = env.TURN_SECRET
        ? createHmac("sha1", env.TURN_SECRET).update(username).digest("base64")
        : env.TURN_PASSWORD!;
      iceServers.push({ urls, username, credential });
    }
    return { iceServers, iceTransportPolicy: policy as RTCIceTransportPolicy };
  }
  return { turnConfigured, getConfiguration };
}
