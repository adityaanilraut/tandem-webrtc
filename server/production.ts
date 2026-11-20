import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { publicOrigin } from "./environment";
import { createSignalingServer } from "./app";
import { createIceProvider } from "./ice";

const directory = resolve("dist");
if (!existsSync(resolve(directory, "index.html")))
  throw new Error("Build the app first: npm run build");
if (!process.env.PUBLIC_ORIGIN)
  throw new Error(
    "Set PUBLIC_ORIGIN to your public HTTPS URL, or use npm run public for an automatic tunnel.",
  );
const origin = publicOrigin(process.env.PUBLIC_ORIGIN);
const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535.");
const clientIpHeader = process.env.CLIENT_IP_HEADER?.trim();
if (clientIpHeader && !/^[a-z0-9-]+$/i.test(clientIpHeader))
  throw new Error("CLIENT_IP_HEADER must be a single header name.");
const ice = createIceProvider();
const server = createSignalingServer({
  origins: new Set([origin]),
  inviteOrigin: origin,
  httpsReady: true,
  publicAccess: true,
  clientIpHeader,
  turnConfigured: ice.turnConfigured,
  iceConfiguration: ice.getConfiguration,
  staticDirectory: directory,
});
try {
  await server.listen(port, process.env.HOST ?? "127.0.0.1");
  console.log(
    `Tandem listening on ${process.env.HOST ?? "127.0.0.1"}:${port}; public URL: ${origin}`,
  );
  console.log(
    ice.turnConfigured
      ? "TURN relay enabled."
      : "Direct connections only. Configure TURN if callers cannot connect across networks.",
  );
} catch (error) {
  await server.close();
  console.error(
    error instanceof Error ? error.message : "Could not start Tandem.",
  );
  process.exitCode = 1;
}
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
  });
