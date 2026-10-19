import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { transferNetworkAddresses } from "../server/file-transfer-network.mjs";
import { createFileTransferManager } from "../server/file_transfer.mjs";

const ipv4 = address => [{ address, family: "IPv4", internal: false }];

test("phone QR ignores the first APIPA adapter and prefers the actual Wi-Fi address", () => {
  const result = transferNetworkAddresses({ "以太网 5": ipv4("169.254.129.223"), WLAN: ipv4("10.128.2.10"), Ethernet: ipv4("192.168.2.3") });
  assert.equal(result[0].address, "10.128.2.10");
  assert.deepEqual(result.map(item => item.address), ["10.128.2.10", "192.168.2.3"]);
});

test("network discovery rejects virtual, loopback, invalid and duplicate addresses", () => {
  const interfaces = {
    "vEthernet (Default Switch)": ipv4("172.23.0.1"), "VMware Network Adapter": ipv4("192.168.20.1"), Tailscale: ipv4("100.64.0.1"),
    WLAN: [...ipv4("10.128.2.10"), ...ipv4("0.0.0.0"), ...ipv4("127.0.0.2"), ...ipv4("224.0.0.1"), ...ipv4("invalid"), { address: "::1", family: "IPv6" }],
    Ethernet: ipv4("10.128.2.10")
  };
  assert.deepEqual(transferNetworkAddresses(interfaces).map(item => item.address), ["10.128.2.10"]);
});

test("offline rooms prefer the Windows hotspot while Wi-Fi rooms prefer WLAN", () => {
  const interfaces = { WLAN: ipv4("10.128.2.10"), "Local Area Connection* 12": ipv4("192.168.137.1") };
  assert.equal(transferNetworkAddresses(interfaces, "offline")[0].address, "192.168.137.1");
  assert.equal(transferNetworkAddresses(interfaces, "lan")[0].address, "10.128.2.10");
});

async function setup(t, initialInterfaces) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-transfer-network-"));
  let interfaces = initialInterfaces;
  const manager = createFileTransferManager({ defaultDownloadDir: root, rootDir: process.cwd(), networkInterfaces: () => interfaces });
  const app = express();
  app.use(express.json());
  app.use(manager.localRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { response, ...await response.json() };
  };
  const { session } = await request("/sessions", {});
  return { session, request, base, network: next => { interfaces = next; } };
}

test("QR/network refresh preserves the room, pairing and shared files, and follows Wi-Fi changes", async t => {
  const f = await setup(t, { Ethernet: ipv4("169.254.129.223"), WLAN: ipv4("10.128.2.10"), "Ethernet 2": ipv4("192.168.2.3") });
  const original = f.session;
  assert.equal(new URL(original.primaryUrl).hostname, "10.128.2.10");
  const remote = new URL(original.loopbackUrl);
  const token = remote.pathname.split("/").pop();
  const page = await fetch(original.loopbackUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /pair-form/);
  const pair = await fetch(`${remote.origin}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, code: original.pairingCode }) }).then(response => response.json());
  const files = new FormData();
  files.append("files", new Blob(["keep this file"]), "notes.txt");
  assert.equal((await fetch(`${f.base}/sessions/current/files`, { method: "POST", body: files })).status, 201);
  const selected = (await f.request("/sessions/current/network", { address: "192.168.2.3" })).session;
  assert.equal(new URL(selected.primaryUrl).hostname, "192.168.2.3");
  assert.notEqual(selected.qrDataUrl, original.qrDataUrl);
  assert.equal(selected.id, original.id);
  assert.equal(selected.pairingCode, original.pairingCode);
  assert.equal((await f.request("/sessions/current")).session.selectedAddress, "192.168.2.3", "polling preserves manual choice");
  const invalid = await f.request("/sessions/current/network", { address: "169.254.129.223" });
  assert.equal(invalid.response.status, 400);
  assert.equal((await f.request("/sessions/current")).session.selectedAddress, "192.168.2.3");
  f.network({ WLAN: ipv4("10.128.3.10") });
  const changed = (await f.request("/sessions/current")).session;
  assert.equal(new URL(changed.primaryUrl).hostname, "10.128.3.10");
  assert.equal(new URL(changed.primaryUrl).pathname, remote.pathname);
  assert.equal(changed.id, original.id);
  assert.equal(changed.sharedFiles[0].name, "notes.txt");
  assert.notEqual(changed.qrDataUrl, selected.qrDataUrl);
  const paired = await fetch(`${remote.origin}/api/session?token=${token}`, { headers: { Authorization: `Bearer ${pair.auth}` } });
  assert.equal(paired.status, 200, "previously paired clients still work");
  const download = await fetch(`${remote.origin}/api/files/${changed.sharedFiles[0].id}/download?token=${token}&auth=${pair.auth}`);
  assert.equal(await download.text(), "keep this file");
});

test("automatic selection upgrades to Wi-Fi when it appears, while explicit selection is kept", async t => {
  const f = await setup(t, { Ethernet: ipv4("192.168.2.3") });
  f.network({ Ethernet: ipv4("192.168.2.3"), WLAN: ipv4("10.128.2.10") });
  assert.equal((await f.request("/sessions/current")).session.selectedAddress, "10.128.2.10");
  await f.request("/sessions/current/network", { address: "192.168.2.3" });
  assert.equal((await f.request("/sessions/current")).session.selectedAddress, "192.168.2.3");
});

test("no network never advertises localhost, and reconnect restores QR without a new room", async t => {
  const f = await setup(t, { Ethernet: ipv4("169.254.129.223") });
  assert.equal(f.session.networkAvailable, false);
  assert.equal(f.session.primaryUrl, "");
  assert.equal(f.session.qrDataUrl, "");
  f.network({ WLAN: ipv4("192.168.1.10") });
  const current = (await f.request("/sessions/current/network", {})).session;
  assert.equal(current.networkAvailable, true);
  assert.match(current.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(current.id, f.session.id);
  f.network({});
  const disconnected = (await f.request("/sessions/current")).session;
  assert.equal(disconnected.qrDataUrl, "");
  assert.equal(disconnected.networkAvailable, false);
});
