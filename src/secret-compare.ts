import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets in constant time.
 *
 * The value is digested first, so two secrets of different lengths are
 * compared without the comparison itself leaking the length through an early
 * return. An absent secret never matches.
 */
export function sameSecret(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** The bearer token of an Authorization header, when it carries one. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
