import { checkoutInput } from "@storefront/app/orders-input";
import type { CheckoutValidationIssue } from "./failure";

/** Server-only replay of App validation so nested paths survive the RPC's flattened field errors. */
export function checkoutValidationIssues(input: unknown): CheckoutValidationIssue[] {
  const result = checkoutInput.safeParse(input);
  return result.success ? [] : result.error.issues.map(({ path, code }) => ({ path, code }));
}
