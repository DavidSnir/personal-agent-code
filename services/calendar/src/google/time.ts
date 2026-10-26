const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateString(value: string, name: string): void {
  if (!datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${name} must be an ISO date in YYYY-MM-DD format`);
  }
}

export function addDays(date: string, days: number): string {
  assertDateString(date, "date");
  const [year, month, day] = date.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day + days);
  return new Date(utc).toISOString().slice(0, 10);
}

export function utcMsForLocalDateStart(date: string, timeZone: string): number {
  assertDateString(date, "date");
  const [year, month, day] = date.split("-").map(Number);
  let utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  utcMs -= getTimeZoneOffsetMs(timeZone, new Date(utcMs));
  utcMs -= getTimeZoneOffsetMs(timeZone, new Date(utcMs)) - getTimeZoneOffsetMs(timeZone, new Date(Date.UTC(year, month - 1, day)));
  return utcMs;
}

export function dateStringInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function getTimeZoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - date.getTime();
}
