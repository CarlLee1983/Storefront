/** 網址代稱的規則：App 驗證與 Web 後台表單共用同一份。 */
export const MAX_SLUG_LENGTH = 64;

/** 小寫英文、數字與單一連字號分隔，不可以連字號開頭或結尾。 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidSlug = (slug: string) => slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
