import "../server/environment";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSignalingServer } from "../server/app";
import { createIceProvider } from "../server/ice";

let tunnel: ChildProcess | undefined;
let server: ReturnType<typeof createSignalingServer> | undefined;
let stopping = false;
let cancelStartup: ((error: Error) => void) | undefined;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  cancelStartup?.(new Error("Public startup stopped."));
  tunnel?.kill("SIGTERM");
  if (server) await server.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void stop());

try {
  const directory = resolve("dist");
  if (!existsSync(resolve(directory, "index.html")))
    throw new Error("Build the app first: npm run build");
  const ice = createIceProvider();
  const options = {
    origins: new Set<string>(),
    inviteOrigin: "",
    httpsReady: true,
    publicAccess: true,
    clientIpHeader: "cf-connecting-ip",
    turnConfigured: ice.turnConfigured,
    iceConfiguration: ice.getConfiguration,
    staticDirectory: directory,
  };
  server = createSignalingServer(options);
  // Use a free loopback port. The existing LAN development server can keep running.
  const port = await server.listen(0);
  if (stopping) throw new Error("Public startup stopped.");
  console.log("Starting a public HTTPS link…");
  tunnel = spawn(
    "cloudflared",
    [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${port}`,
      "--protocol",
      "http2",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const origin = await new Promise<string>((resolveOrigin, reject) => {
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            "Timed out creating the public link. Check your internet connection and try again.",
          ),
        ),
      45_000,
    );
    let output = "";
    const fail = (error: Error) => {
      clearTimeout(timer);
      cancelStartup = undefined;
      reject(error);
    };
    cancelStartup = fail;
    const read = (chunk: Buffer) => {
      const line = chunk.toString();
      output = (output + line).slice(-16_384);
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/.exec(
        output,
      )?.[0];
      if (url) {
        clearTimeout(timer);
        cancelStartup = undefined;
        resolveOrigin(url);
      }
      // Keep connector diagnostics available without printing app secrets.
      if (/ERR|WRN/.test(line)) process.stderr.write(line);
    };
    tunnel!.stdout!.on("data", read);
    tunnel!.stderr!.on("data", read);
    tunnel!.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        new Error(
          error.code === "ENOENT"
            ? "Install cloudflared first: brew install cloudflared (or see README.md for other systems)."
            : "Could not start cloudflared.",
        ),
      ),
    );
    tunnel!.once("exit", (code) => {
      const error = new Error(
        `The HTTPS tunnel stopped (exit ${code ?? "signal"}). Run npm run public again.`,
      );
      fail(error);
      if (!stopping) {
        console.error(error.message);
        void stop(1);
      }
    });
  });
  if (!stopping) {
    // Trust only this exact assigned origin; do not allow arbitrary tunnel domains.
    options.origins.add(origin);
    options.inviteOrigin = origin;
    console.log(`Checking public HTTPS access: ${origin}`);
    const deadline = Date.now() + 30_000;
    let reachable = false;
    let lastFailure = "No response from the public hostname.";
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/api/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok && (await response.json()).ok === true) {
          reachable = true;
          break;
        }
        lastFailure = `The public hostname returned HTTP ${response.status}.`;
      } catch (error) {
        /* DNS and the new tunnel route can take a moment to propagate. */
        lastFailure =
          error instanceof Error
            ? error.message
            : "Public access check failed.";
      }
      await delay(1000);
    }
    if (stopping) throw new Error("Public startup stopped.");
    if (!reachable)
      console.warn(
        `Public access is not verified from this computer yet. ${lastFailure} The tunnel is still running; allow DNS to update and try the link on your phone. If it stays unavailable, restart npm run public.`,
      );
    console.log(`\nOpen and share: ${origin}`);
    if (reachable) console.log("Public HTTPS access verified.");
    console.log(
      "Phones need no certificate installation. Allow camera and microphone access in the browser.",
    );
    console.log(
      ice.turnConfigured
        ? "TURN relay enabled for networks that block direct calls."
        : "Using free STUN/direct calls. If callers cannot connect across networks, add a TURN service in .env.local (see README.md).",
    );
    console.log(
      "Keep this computer awake and this command running. Ctrl+C stops the link. A restart creates a new URL.\n",
    );
  }
} catch (error) {
  if (!stopping)
    console.error(
      error instanceof Error
        ? error.message
        : "Could not start public calling.",
    );
  await stop(stopping ? (process.exitCode ? 1 : 0) : 1);
}
