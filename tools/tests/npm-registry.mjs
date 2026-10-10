import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

function buildVersionMeta(host, port, pkgName, ver, verData) {
  return {
    ...verData.manifest,
    name: pkgName,
    version: ver,
    dist: {
      shasum: verData.shasum,
      integrity: verData.integrity,
      tarball: `http://${host}:${port}/${pkgName}/-/${verData.filename}`,
    },
  };
}

function handleRegistryRequest(req, res, host, server, packages, requests) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  requests.push({ method: req.method, path: pathname });

  for (const [pkgName, pkgData] of packages.entries()) {
    for (const verData of pkgData.versions.values()) {
      if (
        pathname === `/tarballs/${verData.filename}` ||
        pathname === `/${pkgName}/-/${verData.filename}` ||
        pathname.endsWith(`/${verData.filename}`)
      ) {
        if (verData.tarballStatus && verData.tarballStatus !== 200) {
          res.writeHead(verData.tarballStatus, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: `HTTP ${verData.tarballStatus}` }));
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": verData.buffer.length,
        });
        return res.end(req.method === "HEAD" ? undefined : verData.buffer);
      }
    }

    const assignedPort = server.address() ? server.address().port : 0;

    if (pathname === `/${pkgName}/latest`) {
      const verData = pkgData.versions.get(pkgData.latestVersion);
      if (verData) {
        const json = JSON.stringify(buildVersionMeta(host, assignedPort, pkgName, pkgData.latestVersion, verData));
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
        return res.end(json);
      }
    }

    if (pathname === `/${pkgName}` || pathname === `/${encodeURIComponent(pkgName)}`) {
      const versions = {};
      for (const [ver, verData] of pkgData.versions.entries()) {
        versions[ver] = buildVersionMeta(host, assignedPort, pkgName, ver, verData);
      }
      const json = JSON.stringify({
        _id: pkgName,
        name: pkgName,
        "dist-tags": { latest: pkgData.latestVersion },
        versions,
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
      return res.end(json);
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

export function createLocalRegistry(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = options.port || 0;
  const packages = new Map();
  const sockets = new Set();
  const requests = [];

  const server = http.createServer((req, res) => {
    try {
      handleRegistryRequest(req, res, host, server, packages, requests);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function closeRegistry() {
    if (typeof server.closeAllConnections === "function") {
      try { server.closeAllConnections(); } catch {}
    }
    for (const socket of sockets) {
      try { socket.destroy(); } catch {}
    }
    sockets.clear();
    return new Promise((resolveClose) => {
      if (!server.listening) return resolveClose();
      const timer = setTimeout(() => {
        try { server.unref(); } catch {}
        resolveClose();
      }, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }

  return {
    close: closeRegistry,
    start() {
      return new Promise((resolveStart, rejectStart) => {
        server.listen(port, host, () => {
          const assignedPort = server.address().port;
          resolveStart({
            port: assignedPort,
            url: `http://${host}:${assignedPort}`,
            requests,
            addPackage({ name, version, tarballPath, tarballBuffer, manifest = {}, tarballStatus = 200 }) {
              const buffer = tarballBuffer || readFileSync(tarballPath);
              const shasum = crypto.createHash("sha1").update(buffer).digest("hex");
              const integrity = `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
              const filename = `${name.replace(/^@.*\//, "")}-${version}.tgz`;
              if (!packages.has(name)) {
                packages.set(name, { latestVersion: version, versions: new Map() });
              }
              const pkgData = packages.get(name);
              pkgData.latestVersion = version;
              pkgData.versions.set(version, { buffer, shasum, integrity, filename, manifest, tarballStatus });
            },
            close: closeRegistry,
          });
        });
        server.on("error", rejectStart);
      });
    },
  };
}
