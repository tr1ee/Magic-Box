import readline from "node:readline";
const send = event => process.stdout.write(JSON.stringify(event) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "profile.warm") setTimeout(() => send({ type: "profile.warm", requestId: message.requestId, profileId: message.profileId, warmed: true }), 250);
  if (message.type === "runtime.close") process.exit(0);
}
