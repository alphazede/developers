/* eslint-disable @typescript-eslint/no-require-imports */
const { appendFileSync } = require("node:fs");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const allowedPort = Number(process.env.APP_SMOKE_PORT);
const buildIpcCandidate = process.env.APP_ALLOW_TURBOPACK_IPC === "1" && /^\d+$/.test(process.argv[2] ?? "") ? Number(process.argv[2]) : NaN;
const buildIpcPort = Number.isSafeInteger(buildIpcCandidate) && buildIpcCandidate > 0 && buildIpcCandidate <= 65_535 ? buildIpcCandidate : NaN;
const receipt = process.env.APP_NETWORK_RECEIPT;
const loopback = (host) => [undefined, "127.0.0.1", "::1", "localhost"].includes(host);
const deny = (name) => {
  process.exitCode = 1;
  if (receipt) appendFileSync(receipt, `${name}\n`);
  return new Error(`outbound network blocked: ${name}`);
};
const denied = (name) => () => { throw deny(name); };
const rejected = (name) => () => Promise.reject(deny(name));

const lookup = dns.lookup.bind(dns);
dns.lookup = (host, ...args) => loopback(host) ? lookup(host, ...args) : denied("dns.lookup")();
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) dns[name] = denied(`dns.${name}`);
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) dns.promises[name] = rejected(`dns.promises.${name}`);

const connect = (original, name) => function (...args) {
  const value = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
  if (loopback(value.host) && [allowedPort, buildIpcPort].includes(Number(value.port))) return original.apply(this, args);
  throw deny(name);
};
net.connect = connect(net.connect, "socket");
net.createConnection = net.connect;
tls.connect = connect(tls.connect, "tls");

for (const [client, name] of [[http, "http"], [https, "https"]]) {
  const request = client.request.bind(client);
  client.request = (...args) => {
    const value = typeof args[0] === "string" ? new URL(args[0]) : args[0];
    const host = value.hostname ?? value.host;
    const port = Number(value.port || (name === "https" ? 443 : 80));
    if (loopback(host) && port === allowedPort) return request(...args);
    throw deny(name);
  };
  client.get = (...args) => client.request(...args).end();
}

const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (loopback(url.hostname) && Number(url.port) === allowedPort) return originalFetch(input, init);
  throw deny("fetch");
};
