// The install flow before /start: either save the source the user chose, or
// ask the workbench whether a choice is still needed. A failed save throws,
// so the install never starts with a choice the user did not get.
export async function beginInstall(api, { mirrorChoice = "", checkMirrors = false, startOptions = {} } = {}) {
  if (mirrorChoice) {
    await api("/host/debian-mirrors", { preference: mirrorChoice });
  } else if (checkMirrors) {
    const probe = await api("/host/debian-mirrors");
    if (!probe.decided) return { mirrors: probe };
  }
  await api("/environment/initialization", { action: "install" });
  return { accepted: await api("/start", startOptions) };
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond) return "—";
  if (bytesPerSecond >= 1 << 20) return `${(bytesPerSecond / (1 << 20)).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

export const mirrorNames = {
  auto: "自动（官方源优先）",
  official: "仅 Debian 官方源",
  tw: "台湾大学镜像",
  tuna: "清华大学镜像",
  zju: "浙江大学镜像",
  nju: "南京大学镜像",
  ustc: "中国科学技术大学镜像",
};

export const mirrorOptions = [
  ["auto", "自动（官方源优先）"],
  ["tw", "台湾大学镜像"],
  ["tuna", "清华大学镜像"],
  ["zju", "浙江大学镜像"],
  ["nju", "南京大学镜像"],
  ["ustc", "中国科学技术大学镜像"],
  ["official", "仅 Debian 官方源"],
];
