/**
 * Alchemy provider for Salesforce org configuration.
 *
 * Import the namespace and pass `providers()` to a stack:
 *
 * ```ts
 * import { localState, Stack } from "alchemy";
 * import * as Salesforce from "alchemy-salesforce";
 *
 * export default Stack("SalesforceOrg", {
 *   providers: Salesforce.providers(),
 *   state: localState(),
 * }, program);
 * ```
 */
export * from "./salesforce/index.js";
