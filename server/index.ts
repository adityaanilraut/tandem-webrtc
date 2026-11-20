import { createSignalingServer } from "./app";
import { devEnvironment, SIGNAL_PORT } from "./environment";
import { createIceProvider } from "./ice";

const environment = devEnvironment();
const ice = createIceProvider();
const server = createSignalingServer({
  ...environment,
  turnConfigured: ice.turnConfigured,
  iceConfiguration: ice.getConfiguration,
});
try {
  await server.listen(SIGNAL_PORT);
  console.log(`Signaling listening on 127.0.0.1:${SIGNAL_PORT}`);
  console.log(`Invite origin: ${environment.inviteOrigin}`);
  if (!environment.httpsReady)
    console.log(
      "Localhost mode. Run npm run public to share a trusted HTTPS link with phones.",
    );
} catch (error) {
  console.error("Could not start signaling server:", error);
  process.exit(1);
}
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    process.exit(0);
  });
}
