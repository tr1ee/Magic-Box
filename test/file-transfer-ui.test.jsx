import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FileTransferPage from "../src/pages/FileTransferPage.jsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const first = "http://10.128.2.10:52345/s/room";
const second = "http://192.168.2.3:52345/s/room";
const room = {
  id: "room", mode: "lan", networkAvailable: true, urls: [first, second], primaryUrl: first, selectedAddress: "10.128.2.10",
  networkAddresses: [{ address: "10.128.2.10", interfaceName: "WLAN", url: first }, { address: "192.168.2.3", interfaceName: "Ethernet", url: second }],
  qrDataUrl: "data:image/png;base64,first", pairingCode: "123456", connectedDevices: [], sharedFiles: [], receivedFiles: []
};
const props = { onError: vi.fn(), onNotice: vi.fn(), onOpenPath: vi.fn() };

it("changing network updates the actual QR and copy-link target", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url, options) => url.endsWith("/network")
    ? json({ session: { ...room, selectedAddress: JSON.parse(options.body).address, primaryUrl: second, qrDataUrl: "data:image/png;base64,second" } })
    : json({ session: room })));
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<FileTransferPage {...props} />);
  fireEvent.change(await screen.findByRole("combobox", { name: "连接地址（二维码）" }), { target: { value: "192.168.2.3" } });
  await waitFor(() => expect(screen.getByAltText("QR code for this transfer room")).toHaveAttribute("src", "data:image/png;base64,second"));
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(second));
});

it("refresh reconnects a room that initially has no usable network", async () => {
  vi.stubGlobal("fetch", vi.fn(async url => json({ session: url.endsWith("/network") ? room : { ...room, networkAvailable: false, networkAddresses: [], primaryUrl: "", qrDataUrl: "" } })));
  render(<FileTransferPage {...props} />);
  await screen.findByText("No usable local network found.");
  expect(screen.queryByAltText("QR code for this transfer room")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新网络" }));
  expect(await screen.findByAltText("QR code for this transfer room")).toHaveAttribute("src", room.qrDataUrl);
});

it("a delayed network selection cannot reopen a stopped room", async () => {
  let finish;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (options?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/network")) return new Promise(resolve => { finish = resolve; });
    return json({ session: room });
  }));
  render(<FileTransferPage {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "刷新网络" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop room" }));
  await screen.findByRole("button", { name: "Start transfer room" });
  finish(json({ session: room }));
  await waitFor(() => expect(screen.queryByText("Room live")).toBeNull());
});
