interface ResourceSample {
  at: string;
  data: { Name: string; CPUPerc: string; MemUsage: string }[];
}
export function summarizeResources(samples: ResourceSample[]) {
  const rows = new Map<
    string,
    {
      name: string;
      maxCpuPercent: number;
      maxMemoryBytes: number;
      samples: number;
    }
  >();
  for (const sample of samples)
    for (const item of sample.data) {
      const name = item.Name.replace(
        /^fleet-load-\d+-\d+-(?:success|failure|unresponsive)-\d+-/,
        "",
      ).replace(/-1$/, "");
      const row = rows.get(name) ?? {
        name,
        maxCpuPercent: 0,
        maxMemoryBytes: 0,
        samples: 0,
      };
      const match = item.MemUsage.match(/^([\d.]+)([KMGT]?i?B)/);
      const unit: Record<string, number> = {
        B: 1,
        kB: 1000,
        KB: 1000,
        KiB: 1024,
        MB: 1e6,
        MiB: 1024 ** 2,
        GB: 1e9,
        GiB: 1024 ** 3,
        TiB: 1024 ** 4,
      };
      if (
        !match ||
        unit[match[2]!] === undefined ||
        !Number.isFinite(parseFloat(item.CPUPerc))
      )
        throw new Error("invalid Docker sample");
      row.maxMemoryBytes = Math.max(
        row.maxMemoryBytes,
        Number(match[1]) * unit[match[2]!]!,
      );
      row.maxCpuPercent = Math.max(row.maxCpuPercent, parseFloat(item.CPUPerc));
      row.samples++;
      rows.set(name, row);
    }
  return [...rows.values()];
}
export function firstVisibleMs(
  samples: { at: string; acknowledged: number; finished: number }[],
  startedAt: string,
  expected: number,
  field: "acknowledged" | "finished",
) {
  const found = samples.find((s) => s[field] >= expected);
  return expected > 0 && found
    ? Date.parse(found.at) - Date.parse(startedAt)
    : null;
}
