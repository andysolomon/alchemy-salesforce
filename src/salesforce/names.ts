import * as Effect from "effect/Effect";
import { SalesforceValidationError } from "./errors.js";

/** Salesforce developer name: letter, then letters, digits, or single underscores, at most 40 characters. */
export const isDeveloperName = (name: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !name.includes("__") && !name.endsWith("_") && name.length <= 40;

export const requireDeveloperName = (
  value: string,
  label: string,
): Effect.Effect<string, SalesforceValidationError> => {
  const name = value.trim();
  if (!isDeveloperName(name)) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `${label} '${value}' must be a Salesforce developer name: ` +
          "start with a letter, use only letters, numbers, and single underscores, " +
          "and be at most 40 characters.",
      }),
    );
  }
  return Effect.succeed(name);
};
