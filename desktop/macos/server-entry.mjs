import fs from "node:fs/promises";
import { startServer } from "../../server/index.mjs";

const context = await startServer({ host: "127.0.0.1", port: 0 });
const readyFile = process.env.MAGIC_BOX_READY_FILE;
if (!readyFile) throw new Error("Desktop readiness path is missing.");
await fs.writeFile(`${readyFile}.tmp`, JSON.stringify({ url: context.url }));
await fs.rename(`${readyFile}.tmp`, readyFile);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  await context.close();
  await fs.rm(readyFile, { force: true });
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
// Also clean up after an unexpected shell crash.
const parent = process.ppid;
setInterval(() => {
  try { process.kill(parent, 0); } catch { void close(); }
}, 2000).unref();
