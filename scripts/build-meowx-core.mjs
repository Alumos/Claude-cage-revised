// Build and cache the pinned MeowX proxy core from its verified source archive.
// Every platform (macOS arm64/amd64, Linux amd64, Windows amd64) shares this
// script so version pins, build tags, ldflags, and GPL-3.0 notices stay aligned.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import { fetchBuildArtifact, sha256 } from "./fetch-build-artifact.mjs";
import { isMainModule } from "./is-main-module.mjs";

const SPEC_URL = new URL("./meowx-core.json", import.meta.url);
const VALID_OS = new Set(["darwin", "linux", "windows"]);
const VALID_ARCH = new Set(["arm64", "amd64"]);

export function loadCoreSpec() {
  const spec = JSON.parse(readFileSync(SPEC_URL, "utf8"));
  if (!/^v[\d.]+$/.test(spec.version || "")) {
    throw new Error(`Invalid meowx-core version: ${spec.version}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(spec.sourceSha256 || "")) {
    throw new Error("meowx-core.json requires a 64-hex SHA-256 source digest.");
  }
  return spec;
}

export function defaultGoOS(platform = process.platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  throw new Error(`Unsupported host platform for default --os: ${platform}`);
}

export function defaultGoArch(arch = process.arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64" || arch === "amd64") return "amd64";
  throw new Error(`Unsupported host architecture for default --arch: ${arch}`);
}

export function tarCommand(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "tar";
  const system = join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return existsSync(system) ? system : "tar.exe";
}

export function buildGoEnv(baseEnv, goos, goarch, spec = loadCoreSpec()) {
  const env = { ...baseEnv };
  for (const key of [
    "CGO_CFLAGS",
    "CGO_LDFLAGS",
    "CGO_CPPFLAGS",
    "CGO_CXXFLAGS",
    "MACOSX_DEPLOYMENT_TARGET",
    "GOFLAGS",
    "GOAMD64",
  ]) {
    delete env[key];
  }
  env.CGO_ENABLED = "0";
  env.GOWORK = "off";
  env.GOOS = goos;
  env.GOARCH = goarch;
  if (goarch === "amd64") env.GOAMD64 = "v1";
  if (spec.goToolchain && env.GOTOOLCHAIN !== "local") {
    env.GOTOOLCHAIN = spec.goToolchain;
  }
  return env;
}

export function buildLdflags(spec) {
  return [
    "-s -w -buildid=",
    `-X github.com/metacubex/mihomo/constant.Version=${spec.coreVersion}`,
    `-X github.com/metacubex/mihomo/constant.BuildTime=${spec.buildTime}`,
  ].join(" ");
}

export function computeCacheKey(spec, goos, goarch, toolchainId) {
  return createHash("sha256")
    .update(JSON.stringify({
      sourceSha256: spec.sourceSha256.toLowerCase(),
      coreVersion: spec.coreVersion,
      buildTime: spec.buildTime,
      buildTags: spec.buildTags,
      goos,
      goarch,
      toolchainId,
    }))
    .digest("hex");
}

export function renderNotice(spec) {
  return [
    `Mihomo (MeowX core) ${spec.version} (${spec.coreVersion}), distributed as a separate executable by Cage.`,
    `Upstream: ${spec.repo}`,
    `Commit: ${spec.commit}`,
    `Corresponding source: ${spec.sourceURL}`,
    `Archive: ${spec.sourceFile}`,
    `SHA-256: ${spec.sourceSha256}`,
    "License: GPL-3.0. See LICENSE.",
    "",
  ].join("\n");
}

async function isRegularFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteFile(destination, content, mode) {
  const dir = dirname(destination);
  await mkdir(dir, { recursive: true });
  const stage = await mkdtemp(join(dir, ".meowx-write-"));
  const part = join(stage, "file.part");
  try {
    await writeFile(part, content);
    if (mode && process.platform !== "win32") await chmod(part, mode);
    await rename(part, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function atomicCopyFile(source, destination, mode) {
  const dir = dirname(destination);
  await mkdir(dir, { recursive: true });
  const stage = await mkdtemp(join(dir, ".meowx-copy-"));
  const part = join(stage, "file.part");
  try {
    await copyFile(source, part);
    if (mode && process.platform !== "win32") await chmod(part, mode);
    await rename(part, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function atomicGzipFile(source, destination) {
  const dir = dirname(destination);
  await mkdir(dir, { recursive: true });
  const stage = await mkdtemp(join(dir, ".meowx-gzip-"));
  const part = join(stage, "file.gz.part");
  try {
    await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(part));
    await rename(part, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function defaultRunner(command, args, options) {
  return execFileSync(command, args, options);
}

async function readVerifiedGzipCache(gzipPath, expectedCacheKey) {
  const metaPath = `${gzipPath}.json`;
  if (!(await isRegularFile(gzipPath)) || !(await isRegularFile(metaPath))) return null;
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    if (meta.cacheKey !== expectedCacheKey || !/^[a-f0-9]{64}$/i.test(meta.sha256 || "")) {
      return null;
    }
    const actual = await sha256(gzipPath);
    if (actual !== meta.sha256.toLowerCase()) return null;
    return { gzipPath, gzipSha256: actual };
  } catch {
    return null;
  }
}

async function readVerifiedBinaryCache(binPath) {
  const sumPath = `${binPath}.sha256`;
  if (!(await isRegularFile(binPath)) || !(await isRegularFile(sumPath))) return null;
  try {
    const expected = (await readFile(sumPath, "utf8")).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) return null;
    const actual = await sha256(binPath);
    if (actual !== expected) return null;
    return actual;
  } catch {
    return null;
  }
}

async function writeLicenses({ spec, sourceDirOverride, sourceArchive, licenseDir, run, tar }) {
  await mkdir(licenseDir, { recursive: true });
  const licenseDest = join(licenseDir, "LICENSE");
  if (sourceDirOverride) {
    await atomicCopyFile(join(sourceDirOverride, "LICENSE"), licenseDest);
  } else {
    const stage = await mkdtemp(join(tmpdir(), "cage-meowx-license-"));
    try {
      run(tar, ["-xzf", sourceArchive, "-C", stage, `${spec.sourceDir}/LICENSE`], { stdio: "inherit" });
      await atomicCopyFile(join(stage, spec.sourceDir, "LICENSE"), licenseDest);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  await atomicWriteFile(join(licenseDir, "NOTICE"), renderNotice(spec));
}

export async function buildMeowxCore(options = {}) {
  const spec = options.spec || loadCoreSpec();
  const baseEnv = options.env || process.env;
  const fetchArtifact = options.fetchArtifact || fetchBuildArtifact;
  const run = options.run || defaultRunner;
  const tar = options.tar || tarCommand(process.platform, baseEnv);
  const goBin = options.goBin || baseEnv.CAGE_GO_BIN || "go";
  const cacheDir = resolve(options.cacheDir || "_output/meowx-core-cache");
  const sourceDirOverride = options.sourceDirOverride ?? (baseEnv.MEOWX_CORE_SRC || "").trim();

  let sourceArchive = null;
  const ensureSourceArchive = async () => {
    if (sourceDirOverride) return null;
    if (sourceArchive) return sourceArchive;
    const dest = join(cacheDir, spec.sourceFile);
    await fetchArtifact(spec.sourceURL, spec.sourceSha256, dest);
    sourceArchive = dest;
    return dest;
  };

  if (options.prefetchSourceOnly) {
    const archive = await ensureSourceArchive();
    if (options.licenseDir) {
      await writeLicenses({
        spec,
        sourceDirOverride,
        sourceArchive: archive,
        licenseDir: resolve(options.licenseDir),
        run,
        tar,
      });
    }
    return { spec, sourceArchive: archive };
  }

  const goos = options.os || defaultGoOS();
  const goarch = options.arch || defaultGoArch();
  if (!VALID_OS.has(goos)) throw new Error(`Unsupported --os: ${goos}`);
  if (!VALID_ARCH.has(goarch)) throw new Error(`Unsupported --arch: ${goarch}`);

  const outPath = options.out ? resolve(options.out) : null;
  const gzipPath = options.gzip ? resolve(options.gzip) : null;
  const licenseDir = options.licenseDir ? resolve(options.licenseDir) : null;
  if (!outPath && !gzipPath) {
    throw new Error("Specify at least one of --out, --gzip, or --prefetch-source-only.");
  }

  const goEnv = buildGoEnv(baseEnv, goos, goarch, spec);
  let toolchainId = goEnv.GOTOOLCHAIN || "local";
  if (toolchainId === "local") {
    const versionOut = run(goBin, ["version"], { env: goEnv, encoding: "utf8" });
    toolchainId = String(versionOut || "local").trim();
  }
  const cacheKey = computeCacheKey(spec, goos, goarch, toolchainId);

  // Fast path for cloud-kit / gzip-only callers (e.g. CI dependency cache hit
  // where only _output/linux-deps/mihomo-*.gz + .json were restored).
  if (!sourceDirOverride && gzipPath && !outPath && !licenseDir) {
    const hit = await readVerifiedGzipCache(gzipPath, cacheKey);
    if (hit) {
      return { spec, cacheKey, cached: true, gzipPath: hit.gzipPath, gzipSha256: hit.gzipSha256 };
    }
  }

  const ext = goos === "windows" ? ".exe" : "";
  const execMode = goos === "windows" ? undefined : 0o755;
  const builtDir = join(cacheDir, "built");
  const cachedBin = join(builtDir, `meowx-core-${spec.version}-${goos}-${goarch}-${cacheKey.slice(0, 16)}${ext}`);

  let binaryPath = cachedBin;
  let cached = false;
  let binarySha256 = null;
  let tempBuildRoot = null;

  try {
    if (!sourceDirOverride) {
      const hitSha = await readVerifiedBinaryCache(cachedBin);
      if (hitSha) {
        cached = true;
        binarySha256 = hitSha;
      }
    }

    if (!cached) {
      let srcDir = sourceDirOverride ? resolve(sourceDirOverride) : null;
      if (!srcDir) {
        const archive = await ensureSourceArchive();
        tempBuildRoot = await mkdtemp(join(tmpdir(), "cage-meowx-src-"));
        run(tar, ["-xzf", archive, "-C", tempBuildRoot], { stdio: "inherit" });
        srcDir = join(tempBuildRoot, spec.sourceDir);
      }
      const goArgs = [
        "build",
        "-trimpath",
        "-tags",
        spec.buildTags,
        "-ldflags",
        buildLdflags(spec),
      ];
      if (sourceDirOverride) {
        const scratch = await mkdtemp(join(tmpdir(), "cage-meowx-out-"));
        const builtOut = join(scratch, `mihomo${ext}`);
        try {
          run(goBin, [...goArgs, "-o", builtOut, "."], { cwd: srcDir, env: goEnv, stdio: "inherit" });
          binaryPath = builtOut;
          binarySha256 = await sha256(builtOut);
          if (outPath) await atomicCopyFile(binaryPath, outPath, execMode);
          let gzipSha256 = null;
          if (gzipPath) {
            await atomicGzipFile(binaryPath, gzipPath);
            gzipSha256 = await sha256(gzipPath);
          }
          if (licenseDir) {
            await writeLicenses({ spec, sourceDirOverride: srcDir, sourceArchive: null, licenseDir, run, tar });
          }
          return { spec, cacheKey, cached: false, outPath, gzipPath, gzipSha256, binarySha256 };
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }

      await mkdir(builtDir, { recursive: true });
      const stageOut = await mkdtemp(join(builtDir, ".meowx-build-"));
      const partBin = join(stageOut, `mihomo${ext}`);
      try {
        run(goBin, [...goArgs, "-o", partBin, "."], { cwd: srcDir, env: goEnv, stdio: "inherit" });
        if (execMode && process.platform !== "win32") await chmod(partBin, execMode);
        binarySha256 = await sha256(partBin);
        await rename(partBin, cachedBin);
        await atomicWriteFile(`${cachedBin}.sha256`, `${binarySha256}\n`);
      } finally {
        await rm(stageOut, { recursive: true, force: true });
      }
    }

    if (outPath) {
      await atomicCopyFile(binaryPath, outPath, execMode);
    }
    let gzipSha256 = null;
    if (gzipPath) {
      await atomicGzipFile(binaryPath, gzipPath);
      gzipSha256 = await sha256(gzipPath);
      await atomicWriteFile(
        `${gzipPath}.json`,
        JSON.stringify({
          version: spec.version,
          coreVersion: spec.coreVersion,
          goos,
          goarch,
          cacheKey,
          sha256: gzipSha256,
        }, null, 2) + "\n",
      );
    }
    if (licenseDir) {
      const archive = await ensureSourceArchive();
      await writeLicenses({ spec, sourceDirOverride, sourceArchive: archive, licenseDir, run, tar });
    }
    return { spec, cacheKey, cached, outPath, gzipPath, gzipSha256, binarySha256, sourceArchive };
  } finally {
    if (tempBuildRoot) await rm(tempBuildRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      os: { type: "string" },
      arch: { type: "string" },
      out: { type: "string" },
      gzip: { type: "string" },
      "cache-dir": { type: "string" },
      "license-dir": { type: "string" },
      "prefetch-source-only": { type: "boolean", default: false },
      "print-spec": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/build-meowx-core.mjs [--os darwin|linux|windows] [--arch arm64|amd64] " +
      "[--out FILE] [--gzip FILE] [--cache-dir DIR] [--license-dir DIR] [--prefetch-source-only]",
    );
    return;
  }
  if (values["print-spec"]) {
    console.log(JSON.stringify(loadCoreSpec(), null, 2));
    return;
  }
  const result = await buildMeowxCore({
    os: values.os,
    arch: values.arch,
    out: values.out,
    gzip: values.gzip,
    cacheDir: values["cache-dir"],
    licenseDir: values["license-dir"],
    prefetchSourceOnly: values["prefetch-source-only"],
  });
  if (values["prefetch-source-only"]) {
    console.log(`Verified meowx-core source archive at ${result.sourceArchive}`);
  } else {
    const target = result.outPath || result.gzipPath;
    console.log(`${result.cached ? "Reused cached" : "Built"} ${result.spec.coreVersion} at ${target}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
