import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function freezeAssets(files, { masks = [] } = {}) {
  const fileList = Array.isArray(files) ? files : [files];
  const assets = fileList.map((filePath) => {
    const content = readFileSync(filePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    return { path: filePath, sha256 };
  });
  return {
    assets,
    masks: Array.isArray(masks) ? [...masks] : [],
  };
}

export function verifyAssets(record) {
  if (!record || !Array.isArray(record.assets)) {
    throw new Error("Invalid asset record: assets must be an array");
  }
  const masks = Array.isArray(record.masks) ? record.masks : [];

  for (const asset of record.assets) {
    if (!asset || typeof asset.path !== "string") {
      throw new Error("Invalid asset entry: missing path");
    }

    const normPath = asset.path.replace(/\\/g, "/");
    for (const mask of masks) {
      if (typeof mask === "string" && mask.length > 0) {
        const normMask = mask.replace(/\\/g, "/");
        if (asset.path.includes(mask) || normPath.includes(normMask)) {
          throw new Error(`Asset matches mask "${mask}": ${asset.path}`);
        }
      }
    }

    let currentHash;
    try {
      const content = readFileSync(asset.path);
      currentHash = createHash("sha256").update(content).digest("hex");
    } catch (err) {
      throw new Error(`Asset missing or unreadable: ${asset.path} (${err.message})`);
    }

    if (currentHash !== asset.sha256) {
      throw new Error(`Asset hash mismatch for ${asset.path}: expected ${asset.sha256}, got ${currentHash}`);
    }
  }

  return { ok: true, count: record.assets.length };
}
