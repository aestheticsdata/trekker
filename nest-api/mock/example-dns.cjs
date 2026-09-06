"use strict";
/**
 * The mock's names, resolved (TRE-148).
 *
 * The three remote machines are rows whose address is a name under
 * `example.com` — `marlow.example.com` — and servers the mock runs on the
 * loopback. Rather than put an IP in the row (the host manager and the
 * activity log print the address, and the film must never show one) or touch
 * /etc/hosts, the API is started with this file preloaded:
 *
 *   NODE_OPTIONS=--require /abs/path/mock/example-dns.cjs
 *
 * which `df-on-path.ts` sets for the API's own process tree and nothing else.
 * It replaces `dns.lookup` — what `net.Socket#connect` reads, at every
 * connect, from the public `dns` module; ssh2 opens its socket with no lookup
 * of its own — so that any name ending in `.example.com` answers 127.0.0.1,
 * and every other name goes to the real resolver untouched.
 *
 * Two shapes, both from Node itself: `lookup(host, options, cb)` where
 * `options` may be a bare family number (ssh2's forceIPv4 path) or an object,
 * and where `{ all: true }` (Node ≥ 20's happy eyeballs) wants an array of
 * `{ address, family }` rather than a single pair. `util.promisify.custom` is
 * carried over so `util.promisify(dns.lookup)` keeps its shape.
 */
const dns = require("node:dns");
const { promisify } = require("node:util");

const SUFFIX = ".example.com";
const LOOPBACK = "127.0.0.1";

const original = dns.lookup;

function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof hostname !== "string" || !hostname.toLowerCase().endsWith(SUFFIX)) {
    return original.call(dns, hostname, options, callback);
  }
  const all = typeof options === "object" && options !== null && options.all === true;
  process.nextTick(() => {
    if (all) callback(null, [{ address: LOOPBACK, family: 4 }]);
    else callback(null, LOOPBACK, 4);
  });
}

lookup[promisify.custom] = (hostname, options) =>
  new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else if (Array.isArray(address)) resolve(address);
      else resolve({ address, family });
    });
  });

dns.lookup = lookup;
const originalPromised = dns.promises.lookup;
dns.promises.lookup = (hostname, options) =>
  typeof hostname === "string" && hostname.toLowerCase().endsWith(SUFFIX)
    ? lookup[promisify.custom](hostname, options)
    : originalPromised.call(dns.promises, hostname, options);
