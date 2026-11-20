import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { lanAddresses, certPath, keyPath } from "../server/environment";

try {
  execFileSync("mkcert", ["-version"], { stdio: "ignore" });
} catch {
  console.error(
    "Install mkcert first. On macOS: brew install mkcert\nThen run: npm run setup:https",
  );
  process.exit(1);
}
const addresses = [
  ...new Set(
    [process.env.LAN_HOST, ...lanAddresses()].filter((v): v is string =>
      Boolean(v),
    ),
  ),
];
if (addresses.length === 0) {
  console.error("No LAN address found. Connect to Wi-Fi and try again.");
  process.exit(1);
}
mkdirSync(resolve(".certs"), { recursive: true });
// mkcert keeps its CA private key in its own system directory, outside this project.
const skipInstall = process.argv.includes("--no-install");
if (!skipInstall) execFileSync("mkcert", ["-install"], { stdio: "inherit" });
execFileSync(
  "mkcert",
  [
    "-key-file",
    keyPath,
    "-cert-file",
    certPath,
    "localhost",
    "127.0.0.1",
    "::1",
    ...addresses,
  ],
  { stdio: "inherit" },
);
const caRoot = execFileSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).trim();
copyFileSync(join(caRoot, "rootCA.pem"), resolve(".certs/tandem-rootCA.crt"));
console.log(
  `\nHTTPS is configured. Restart npm run dev, then open https://${addresses[0]}:5173 on both devices.\n`,
);
if (skipInstall) {
  console.log(
    "Computer trust is not installed yet. Run mkcert -install in your own Terminal to trust this certificate on the computer.",
  );
}
console.log(
  "For iPhone: run npm run setup:iphone and open its printed HTTP address in Safari to download the public certificate. Install its profile, then enable full trust in Settings → General → About → Certificate Trust Settings.",
);
console.log(
  "Transfer only the public certificate. Never share rootCA-key.pem or dev-key.pem.",
);
console.log(
  "See README.md for the complete iPhone setup and how to remove the development certificate.",
);
