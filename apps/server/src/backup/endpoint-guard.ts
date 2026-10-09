// Keeps a user-supplied S3 endpoint from pointing the gateway at its own
// network: the cloud metadata service, the loopback interface (this gateway
// included), or anything else on a private range. Checked when a destination
// is saved or tested and again at the start of every run.
//
// It is a guard rather than a seal: a name that resolves differently between
// this lookup and the request's own (DNS rebinding) slips past. Operators who
// do want a LAN endpoint turn the whole check off with
// BACKUP_S3_ALLOW_PRIVATE_ENDPOINTS.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: AddressLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export class PrivateEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateEndpointError";
  }
}

function v4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((n, i) => /^\d{1,3}$/.test(parts[i]!) && n >= 0 && n <= 255) ? octets : null;
}

function isPrivateV4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function v6Groups(ip: string): number[] | null {
  let address = ip.toLowerCase();
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  // A trailing dotted quad (::ffff:127.0.0.1) stands for the last two groups.
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = v4Octets(tail);
    if (!octets) return null;
    address =
      address.slice(0, lastColon + 1) +
      ((octets[0]! << 8) | octets[1]!).toString(16) +
      ":" +
      ((octets[2]! << 8) | octets[3]!).toString(16);
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(v4Octets(ip)!);
  if (kind !== 6) return true; // not an address at all: refuse rather than guess
  const groups = v6Groups(ip);
  if (!groups) return true;
  const [g0, , , , , g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const leadingZero = groups.slice(0, 5).every((g) => g === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form.
  if (leadingZero && (g5 === 0xffff || (g5 === 0 && (g6 !== 0 || g7 > 1)))) {
    return isPrivateV4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export async function assertPublicEndpoint(endpoint: string, lookup: AddressLookup = defaultLookup): Promise<void> {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await lookup(hostname);
    } catch {
      throw new PrivateEndpointError(`could not resolve ${hostname}`);
    }
  }
  if (addresses.length === 0) throw new PrivateEndpointError(`could not resolve ${hostname}`);
  if (addresses.some(isPrivateAddress)) {
    throw new PrivateEndpointError(
      `${hostname} resolves to a private or local address; set BACKUP_S3_ALLOW_PRIVATE_ENDPOINTS=true to allow it`,
    );
  }
}
