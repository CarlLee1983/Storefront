import { loginUrl } from "../auth/customer";

type Customer = App.Locals["customer"];

export type CheckoutEntry = { kind: "allow" } | { kind: "redirect"; location: string };

/** 結帳入口只給顧客：未登入導向登入頁（登入後回到目前這一頁），已登入放行。 */
export function checkoutEntry(customer: Customer, url: URL): CheckoutEntry {
  return customer ? { kind: "allow" } : { kind: "redirect", location: loginUrl(url) };
}
