import { createHash } from "node:crypto";

/** SHA-256 hex digest. Callers store this instead of a consumer key or certificate. */
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
