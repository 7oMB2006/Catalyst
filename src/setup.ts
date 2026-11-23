import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostRunner } from "./setup/hosts.js";
import { startSetup } from "./setup/server.js";

const installation = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
try {
  const { url } = await startSetup({
    envFile: env.DOTENV_CONFIG_PATH ? path.resolve(env.DOTENV_CONFIG_PATH) : path.join(installation, ".env"),
    node: process.execPath,
    entry: path.join(installation, "dist", "index.js"),
    assets: new URL("../web/setup/", import.meta.url),
    env,
    runHost: hostRunner(env, homedir()),
  });
  process.stdout.write("Catalyst setup: " + url + "/\nPress Ctrl+C to stop.\n");
} catch {
  process.stderr.write("Could not start Catalyst setup. Check that the installation includes web/setup.\n");
  process.exitCode = 1;
}
