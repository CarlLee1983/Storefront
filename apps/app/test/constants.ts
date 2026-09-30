import { LOCAL_TEAM_DOMAIN } from "../src/admin/access";

// vitest.config.ts（Node）與測試（workerd）共用的常數
export const TEST_KID = "test-key-1";
/** 內嵌 JWKS 模式的保留網域。 */
export const TEST_TEAM_DOMAIN = LOCAL_TEAM_DOMAIN;
export const TEST_AUD = "test-audience-tag";
/** 測試用的金流閘道位址與金鑰；請求由 `fake-gateway.ts` 攔截，不會真的送出。 */
export const TEST_GATEWAY_BASE_URL = "https://gateway.test";
export const TEST_GATEWAY_API_KEY = "test-gateway-api-key";
