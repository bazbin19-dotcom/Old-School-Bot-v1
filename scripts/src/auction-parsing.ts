const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const digitPattern = /[٠-٩۰-۹]/g;
const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export function normalizeAuctionDigits(value: string) {
  return value.replace(digitPattern, (digit) => {
    const arabicIndex = arabicDigits.indexOf(digit);
    if (arabicIndex >= 0) return String(arabicIndex);
    const persianIndex = persianDigits.indexOf(digit);
    return persianIndex >= 0 ? String(persianIndex) : digit;
  });
}

export function parseAuctionAmount(value: string): string | null {
  const normalized = normalizeAuctionDigits(value.trim())
    .replace(/٫/g, ".")
    .replace(/[٬,\s_]/g, "");
  if (!/^\d{1,18}(?:\.\d{1,6})?$/.test(normalized)) return null;

  const [rawWhole = "0", rawFraction = ""] = normalized.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const amount = fraction ? `${whole}.${fraction}` : whole;
  if (/^0(?:\.0*)?$/.test(amount)) return null;
  return amount;
}

export function parseAuctionDurationMs(value: string): number | null {
  const normalized = normalizeAuctionDigits(value.trim())
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, "")
    .replace(/٫/g, ".")
    .replace(/[،,]/g, " ")
    .replace(/\s+/g, " ");
  const match = normalized.match(/^(?:(\d+(?:\.\d+)?)\s*)?([\p{L}.]+)$/u);
  if (!match) return null;

  const unit = match[2] ?? "";
  const twoCountUnits: Record<string, number> = {
    يومين: 2 * dayMs,
    يومان: 2 * dayMs,
    ساعتين: 2 * hourMs,
    دقيقتين: 2 * minuteMs,
    ثانيتين: 2_000,
  };
  const fixedFactor = twoCountUnits[unit];
  const factor =
    fixedFactor ??
    ([
      [/^(?:s|sec|secs|second|seconds|ثانية|ثواني|ثانيه)$/, 1_000],
      [/^(?:m|min|mins|minute|minutes|دقيقة|دقائق|دقيقه|دقايق)$/, minuteMs],
      [/^(?:h|hr|hrs|hour|hours|ساعة|ساعات|ساعه)$/, hourMs],
      [/^(?:d|day|days|يوم|أيام|ايام)$/, dayMs],
    ] as const).find(([pattern]) => pattern.test(unit))?.[1];
  if (!factor) return null;

  const quantity = match[1] ? Number(match[1]) : 1;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const durationMs = Math.round(quantity * factor);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1_000 ||
    durationMs > 8.64e15 - Date.now()
  ) {
    return null;
  }
  return durationMs;
}

export function formatAuctionAmount(value: string | null) {
  if (!value) return "غير محدد";
  const [whole = "0", fraction] = value.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${groupedWhole}.${fraction}` : groupedWhole;
}

export function formatAuctionDuration(durationMs: string | number | null) {
  if (durationMs === null) return "غير محددة";
  const milliseconds = Number(durationMs);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "غير محددة";

  if (milliseconds % dayMs === 0) {
    const days = milliseconds / dayMs;
    return days === 1
      ? "يوم"
      : days === 2
        ? "يومان"
        : `${days} أيام`;
  }
  if (milliseconds % hourMs === 0) {
    const hours = milliseconds / hourMs;
    return hours === 1
      ? "ساعة"
      : hours === 2
        ? "ساعتان"
        : `${hours} ساعات`;
  }
  if (milliseconds % minuteMs === 0) {
    const minutes = milliseconds / minuteMs;
    return minutes === 1
      ? "دقيقة"
      : minutes === 2
        ? "دقيقتان"
        : `${minutes} دقائق`;
  }
  if (milliseconds % 1_000 === 0) {
    const seconds = milliseconds / 1_000;
    return seconds === 1
      ? "ثانية"
      : seconds === 2
        ? "ثانيتان"
        : `${seconds} ثوانٍ`;
  }
  return `${milliseconds} ملي ثانية`;
}