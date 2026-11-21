/** Human-readable byte size; null or a non-finite value renders as an em dash. */
export function formatBytes(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One decimal place at most; an unknown value is never shown as zero. */
export function formatPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "—";
    return `${Math.round(value * 10) / 10}%`;
}
