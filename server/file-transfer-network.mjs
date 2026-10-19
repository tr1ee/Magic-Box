import os from "node:os";
import { isIPv4 } from "node:net";

export function transferNetworkAddresses(interfaces = os.networkInterfaces(), mode = "lan") {
  const candidates = [];
  const seen = new Set();
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    // These interfaces normally belong to a VM, container, or VPN, not the
    // phone's Wi-Fi. Windows Mobile Hotspot (Local Area Connection*) is allowed.
    if (/vethernet|hyper-v|virtualbox|vmware|docker|wsl|loopback|tailscale|zerotier|wireguard|vpn|\b(?:tun|tap|utun)\d*\b|\bbridge\d*\b/i.test(interfaceName)) continue;
    for (const entry of entries || []) {
      const address = entry?.address;
      if (entry?.internal || !isIPv4(address || "") || !["IPv4", 4].includes(entry.family)) continue;
      const [a, b] = address.split(".").map(Number);
      // APIPA/link-local addresses cannot be used by a normal Wi-Fi client.
      // Never advertise loopback or unspecified/multicast addresses in a QR.
      if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254) || seen.has(address)) continue;
      seen.add(address);
      const wifi = /wi-?fi|wlan|wireless|无线|無線|airport/i.test(interfaceName);
      const hotspot = address === "192.168.137.1" || /local area connection\*|本地连接\*|區域連線\*/i.test(interfaceName);
      const ethernet = /ethernet|以太网|乙太網|\ben\d+\b/i.test(interfaceName);
      const privateAddress = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      const score = (mode === "offline" && hotspot ? 400 : wifi ? 300 : ethernet ? 200 : 100) + (privateAddress ? 20 : 0);
      candidates.push({ address, interfaceName, kind: hotspot ? "hotspot" : wifi ? "wifi" : ethernet ? "ethernet" : "network", score });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.interfaceName.localeCompare(right.interfaceName) || left.address.localeCompare(right.address))
    .map(({ score, ...candidate }) => candidate);
}
