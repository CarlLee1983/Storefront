import { z } from "zod";
import { wholeNumber } from "../shared/input";

const MAX_EMAIL_LENGTH = 254;
const MAX_TOKEN_LENGTH = 200;

/** 聯絡 email：去空白、轉小寫後驗格式；同一個地址不論大小寫視為相同。 */
export const requestContactEmailInput = z.object({
  email: z
    .string({ error: "email 必須是文字" })
    .trim()
    .toLowerCase()
    .max(MAX_EMAIL_LENGTH, `email 不可超過 ${MAX_EMAIL_LENGTH} 個字`)
    .pipe(z.email("email 格式不正確")),
});

export const verifyContactEmailInput = z.object({
  token: z.string({ error: "驗證憑證必須是文字" }).min(1, "驗證憑證不可為空").max(MAX_TOKEN_LENGTH, "驗證憑證無效"),
});

export const mailMessageIdInput = z.object({ messageId: wholeNumber("信件編號").positive("信件編號無效") });

export const setMailDeliveryFailureInput = z.object({ enabled: z.boolean({ error: "投遞失敗開關必須是布林值" }) });
