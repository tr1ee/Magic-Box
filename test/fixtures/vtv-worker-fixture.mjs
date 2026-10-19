import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "shutdown") {
    process.exit(0);
  }
  if (request.command === "hang") {
    return;
  }
  if (request.command === "heartbeat") {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, event: "progress", count })}\n`);
      if (count < 4) return;
      clearInterval(timer);
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, value: "alive" })}\n`);
    }, 25);
    return;
  }
  if (request.command === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  process.stdout.write(`${JSON.stringify({ requestId: request.requestId, ok: true, value: request.value || "ok" })}\n`);
});
