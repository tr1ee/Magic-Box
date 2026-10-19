import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("mobile QR page pairs and transfers even when browser storage is denied", async t => {
  const html = await fs.readFile(new URL("../public/file-transfer.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://192.168.1.10:45678/s/room", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "sessionStorage", { get() { throw new dom.window.DOMException("Storage blocked", "SecurityError"); } });
  let pairs = 0;
  dom.window.fetch = async url => {
    if (url === "/api/pair") pairs++;
    return { ok: true, status: 200, json: async () => ({ auth: "paired", session: { sharedFiles: [] } }) };
  };
  dom.window.eval(dom.window.document.querySelector("script").textContent);
  const doc = dom.window.document;
  assert.equal(doc.getElementById("pair-view").style.display, "block");
  doc.getElementById("pair-code").value = "123456";
  doc.getElementById("pair-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairs, 1);
  assert.equal(doc.getElementById("transfer-view").style.display, "grid");
  assert.equal(doc.getElementById("pair-error").textContent, "");
});
