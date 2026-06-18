interface ParsedHttpBind {
  host: string;
  port: number;
}

export function parseHttpBind(value: string): ParsedHttpBind {
  if (/^\d+$/.test(value)) {
    throw new Error("--http requires :PORT or HOST:PORT format.");
  }

  const ipv6 = value.match(/^\[(::1)\]:(\d+)$/);
  if (ipv6) {
    return { host: ipv6[1], port: parsePort(ipv6[2]) };
  }

  const portOnly = value.match(/^:(\d+)$/);
  if (portOnly) {
    return { host: "127.0.0.1", port: parsePort(portOnly[1]) };
  }

  const hostPort = value.match(/^([^:]+):(\d+)$/);
  if (!hostPort) {
    throw new Error("--http requires :PORT or HOST:PORT format.");
  }

  return {
    host: hostPort[1] === "localhost" ? "127.0.0.1" : hostPort[1],
    port: parsePort(hostPort[2]),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HTTP port must be an integer from 1 to 65535.");
  }
  return port;
}
