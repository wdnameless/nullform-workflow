import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const WAVE_FILE_RE = /^wave-(\d+)\.json$/;

export function checkpointWave(storeDir, wave, state) {
  mkdirSync(storeDir, { recursive: true });
  const waveNum = Number(wave);
  const targetPath = join(storeDir, `wave-${waveNum}.json`);
  const tmpPath = join(storeDir, `.tmp.wave-${waveNum}.${randomBytes(6).toString("hex")}`);

  const payload = {
    wave: waveNum,
    state,
  };

  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmpPath, targetPath);
}

export function resumeWave(storeDir) {
  if (!existsSync(storeDir)) {
    return null;
  }

  const entries = readdirSync(storeDir);
  const waves = [];

  for (const name of entries) {
    const match = WAVE_FILE_RE.exec(name);
    if (match) {
      waves.push({
        num: parseInt(match[1], 10),
        name,
        filePath: join(storeDir, name),
      });
    }
  }

  waves.sort((a, b) => a.num - b.num);

  for (const item of waves) {
    const content = readFileSync(item.filePath, "utf8");
    const parsed = JSON.parse(content);

    let waveNum = item.num;
    let state = parsed;

    if (parsed && typeof parsed === "object" && "state" in parsed) {
      state = parsed.state;
      if (typeof parsed.wave === "number") {
        waveNum = parsed.wave;
      }
    }

    if (!state || state.status !== "complete") {
      return { wave: waveNum, state };
    }
  }

  return null;
}
