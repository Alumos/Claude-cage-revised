import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  buildGoEnv,
  buildLdflags,
  buildMeowxCore,
  computeCacheKey,
  loadCoreSpec,
  renderNotice,
} from "./build-meowx-core.mjs";

const spec = loadCoreSpec();

test("meowx-core pin stays synchronized across macOS, Linux and Windows manifests", async () => {
  const macScript = await readFile(new URL("./fetch-proxy-core.sh", import.meta.url), "utf8");
  const macVersion = macScript.match(/^version=(v[\d.]+)$/m)?.[1];
  const linuxDeps = JSON.parse(await readFile(new URL("../packaging/linux/dependencies.json", import.meta.url), "utf8"));
  const windowsDeps = JSON.parse(await readFile(new URL("../packaging/windows/dependencies.json", import.meta.url), "utf8"));

  assert.equal(macVersion, spec.version);
  assert.equal(linuxDeps.mihomo.version, spec.version);
  assert.equal(linuxDeps.mihomoSource.file, spec.sourceFile);
  assert.equal(linuxDeps.mihomoSource.url, spec.sourceURL);
  assert.equal(linuxDeps.mihomoSource.sha256, spec.sourceSha256);

  assert.equal(windowsDeps.mihomo.version, spec.version);
  assert.equal(windowsDeps.mihomo.source, spec.sourceURL);
  assert.equal(windowsDeps.mihomoSource.version, spec.version);
  assert.equal(windowsDeps.mihomoSource.file, spec.sourceFile);
  assert.equal(windowsDeps.mihomoSource.url, spec.sourceURL);
  assert.equal(windowsDeps.mihomoSource.hash, spec.sourceSha256);
});

test("buildGoEnv strips host CGO/macOS variables and enforces pure-Go target settings", () => {
  const polluted = {
    PATH: "/usr/bin",
    CGO_ENABLED: "1",
    CGO_CFLAGS: "-mmacosx-version-min=14.0",
    CGO_LDFLAGS: "-framework CoreFoundation",
    CGO_CPPFLAGS: "-DTEST",
    CGO_CXXFLAGS: "-O2",
    MACOSX_DEPLOYMENT_TARGET: "14.0",
    GOFLAGS: "-tags=yq_noxml",
    GOAMD64: "v3",
    GOWORK: "/tmp/go.work",
  };

  const amd64 = buildGoEnv(polluted, "linux", "amd64", spec);
  assert.equal(amd64.CGO_ENABLED, "0");
  assert.equal(amd64.GOWORK, "off");
  assert.equal(amd64.GOOS, "linux");
  assert.equal(amd64.GOARCH, "amd64");
  assert.equal(amd64.GOAMD64, "v1");
  assert.equal(amd64.GOTOOLCHAIN, spec.goToolchain);
  for (const stripped of ["CGO_CFLAGS", "CGO_LDFLAGS", "CGO_CPPFLAGS", "CGO_CXXFLAGS", "MACOSX_DEPLOYMENT_TARGET", "GOFLAGS"]) {
    assert.equal(stripped in amd64, false, `${stripped} must be removed`);
  }

  const arm64 = buildGoEnv({ ...polluted, GOTOOLCHAIN: "local" }, "darwin", "arm64", spec);
  assert.equal(arm64.GOOS, "darwin");
  assert.equal(arm64.GOARCH, "arm64");
  assert.equal("GOAMD64" in arm64, false);
  assert.equal(arm64.GOTOOLCHAIN, "local");
});

test("buildMeowxCore builds once, caches binary and gzip, and extracts GPL-3.0 notices", async t => {
  const root = await mkdtemp(join(tmpdir(), "cage-meowx-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeArchiveData = "fake-source-tarball-bytes";
  const fakeSha = createHash("sha256").update(fakeArchiveData).digest("hex");
  const testSpec = { ...spec, sourceSha256: fakeSha };
  const cacheDir = join(root, "cache");
  const outBin = join(root, "out/mihomo");
  const outGz = join(root, "out/mihomo.gz");
  const licenseDir = join(root, "licenses");

  const invocations = [];
  const fetchArtifact = async (_url, expected, dest) => {
    assert.equal(expected, fakeSha);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, fakeArchiveData);
    return dest;
  };
  // Synchronous command runner mirroring execFileSync.
  const fsSync = await import("node:fs");
  const syncRun = (cmd, args, opts) => {
    invocations.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
    if (cmd === "tar") {
      const destDir = args[args.indexOf("-C") + 1];
      const targetDir = join(destDir, testSpec.sourceDir);
      fsSync.mkdirSync(targetDir, { recursive: true });
      fsSync.writeFileSync(join(targetDir, "LICENSE"), "GNU GENERAL PUBLIC LICENSE Version 3\n");
      return "";
    }
    if (cmd === "go" && args[0] === "build") {
      const output = args[args.indexOf("-o") + 1];
      assert.equal(args[args.indexOf("-tags") + 1], testSpec.buildTags);
      assert.equal(args[args.indexOf("-ldflags") + 1], buildLdflags(testSpec));
      assert.equal(opts.env.CGO_ENABLED, "0");
      assert.equal(opts.env.GOOS, "linux");
      assert.equal(opts.env.GOARCH, "amd64");
      assert.equal(opts.env.GOAMD64, "v1");
      fsSync.writeFileSync(output, "fake-meowx-elf-binary");
      return "";
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
  };

  const first = await buildMeowxCore({
    spec: testSpec,
    os: "linux",
    arch: "amd64",
    out: outBin,
    gzip: outGz,
    cacheDir,
    licenseDir,
    fetchArtifact,
    run: syncRun,
    tar: "tar",
    goBin: "go",
    env: { PATH: "/usr/bin" },
  });
  assert.equal(first.cached, false);
  assert.equal(await readFile(outBin, "utf8"), "fake-meowx-elf-binary");
  assert.equal(gunzipSync(await readFile(outGz)).toString("utf8"), "fake-meowx-elf-binary");
  assert.equal(await readFile(join(licenseDir, "LICENSE"), "utf8"), "GNU GENERAL PUBLIC LICENSE Version 3\n");
  assert.equal(await readFile(join(licenseDir, "NOTICE"), "utf8"), renderNotice(testSpec));
  assert.equal(invocations.filter(call => call.cmd === "go").length, 1);

  // Second call reuses the verified binary cache without invoking go build.
  const outBin2 = join(root, "out2/mihomo");
  const second = await buildMeowxCore({
    spec: testSpec,
    os: "linux",
    arch: "amd64",
    out: outBin2,
    cacheDir,
    fetchArtifact,
    run: syncRun,
    tar: "tar",
    goBin: "go",
    env: { PATH: "/usr/bin" },
  });
  assert.equal(second.cached, true);
  assert.equal(await readFile(outBin2, "utf8"), "fake-meowx-elf-binary");
  assert.equal(invocations.filter(call => call.cmd === "go").length, 1);

  // Gzip-only caller hits the verified gzip metadata cache directly.
  const third = await buildMeowxCore({
    spec: testSpec,
    os: "linux",
    arch: "amd64",
    gzip: outGz,
    cacheDir: join(root, "empty-cache"),
    fetchArtifact: async () => { throw new Error("must not download on verified gzip cache hit"); },
    run: () => { throw new Error("must not spawn commands on verified gzip cache hit"); },
    tar: "tar",
    goBin: "go",
    env: { PATH: "/usr/bin" },
  });
  assert.equal(third.cached, true);
  assert.equal(third.cacheKey, computeCacheKey(testSpec, "linux", "amd64", testSpec.goToolchain));
});
