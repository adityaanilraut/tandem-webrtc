import { readFileSync } from "node:fs";
import { devEnvironment, lanAddresses } from "../server/environment";
import { createIPhoneSetupServer } from "../server/iphone-setup";

let certificate: Buffer;
try {
  certificate = readFileSync(".certs/tandem-rootCA.crt");
} catch {
  console.error("Generate the certificate first: npm run setup:https");
  process.exit(1);
}
const environment = devEnvironment();
if (!environment.httpsReady) {
  console.error(
    "The HTTPS server certificate is missing. Run npm run setup:https first.",
  );
  process.exit(1);
}
const server = createIPhoneSetupServer(certificate, environment.inviteOrigin);
server.on("error", (error) => {
  console.error("Could not start the iPhone setup page:", error.message);
  process.exit(1);
});
server.listen(5174, "0.0.0.0", () => {
  const host = process.env.LAN_HOST || lanAddresses()[0] || "localhost";
  console.log(`Open in iPhone Safari: http://${host}:5174`);
  console.log(
    `After trusting the certificate, open ${environment.inviteOrigin}`,
  );
  console.log(
    "This server exposes only the public CA certificate and setup instructions. Stop it with Ctrl+C after setup.",
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
