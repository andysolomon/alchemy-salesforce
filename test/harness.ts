import { clearConnectionCache } from "../src/salesforce/connection.js";
import { startMockOrg, TEST_TOKEN, type MockOrg } from "./mock-org.js";

/** Point the provider at a local mock and drop any cached CLI/env connection. */
export const bindMockOrg = async (): Promise<MockOrg> => {
  const org = await startMockOrg();
  process.env.SF_INSTANCE_URL = org.url;
  process.env.SF_ACCESS_TOKEN = TEST_TOKEN;
  delete process.env.SALESFORCE_INSTANCE_URL;
  delete process.env.SALESFORCE_ACCESS_TOKEN;
  delete process.env.SF_TARGET_ORG;
  delete process.env.SALESFORCE_TARGET_ORG;
  delete process.env.SF_API_VERSION;
  delete process.env.SF_ORG_CREDENTIALS;
  clearConnectionCache();
  return org;
};
