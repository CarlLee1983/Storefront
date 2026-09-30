import { z } from "zod";
import { invalidInput, type InvalidInput } from "./result";

export const wholeNumber = (label: string) =>
  z.number({ error: `${label}必須是數字` }).int(`${label}必須是整數`);

/** 在 RPC 邊界驗證未知輸入；失敗時轉成 `invalid_input`，欄位錯誤放在 `fields`（整體錯誤在 `_form`）。 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; data: z.output<S> } | InvalidInput {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };

  const fields: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
    (fields[field] ??= []).push(issue.message);
  }
  return invalidInput(fields);
}
