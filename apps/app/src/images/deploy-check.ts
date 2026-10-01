import type { DeployEnv } from "../auth/deploy-check";

/** R2 bindings 不會跨環境繼承，App 與 Web 必須宣告相同且環境獨立的 bucket。 */
export function checkImagesDeploy(input: { deployEnv: DeployEnv; appBuckets: unknown; webBuckets: unknown }): string[] {
  const expected = `storefront-product-images-${input.deployEnv}`;
  const problems: string[] = [];
  for (const [label, bindings] of [["App", input.appBuckets], ["Web", input.webBuckets]] as const) {
    const matches = Array.isArray(bindings) ? bindings.filter((value: unknown) => value !== null && typeof value === "object" && "binding" in value && value.binding === "PRODUCT_IMAGES") : [];
    if (matches.length !== 1 || matches[0]?.bucket_name !== expected) {
      problems.push(`${label} env.${input.deployEnv}.r2_buckets 必須有唯一的 PRODUCT_IMAGES，bucket_name 為 ${expected}`);
    }
  }
  return problems;
}
