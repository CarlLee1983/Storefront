/** Reusable feedback for homepage and product-detail add forms. Never moves focus. */
let active: HTMLElement | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let announcement: ReturnType<typeof setTimeout> | undefined;

export function showCartToast(region: HTMLElement, message: string): void {
  clearTimeout(expiry);
  clearTimeout(announcement);
  if (active) active.textContent = "";
  active = region;
  region.textContent = "";
  // A separate update also announces repeated identical messages at the quantity cap.
  announcement = setTimeout(() => {
    region.textContent = message;
    expiry = setTimeout(() => { region.textContent = ""; }, 5000);
  }, 30);
}
