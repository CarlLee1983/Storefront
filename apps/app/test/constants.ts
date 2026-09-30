import { LOCAL_TEAM_DOMAIN } from "../src/admin/access";

// vitest.config.ts（Node）與測試（workerd）共用的常數
export const TEST_KID = "test-key-1";
/** 內嵌 JWKS 模式的保留網域。 */
export const TEST_TEAM_DOMAIN = LOCAL_TEAM_DOMAIN;
export const TEST_AUD = "test-audience-tag";
