/** 選用地址簿：只把內容帶入結帳表單的三個欄位，仍可再修改；送出的是欄位當下的值。 */
export function bindSavedAddressPicker(doc: Document): void {
  const picker = doc.querySelector<HTMLElement>("#saved-address");
  picker?.addEventListener("change", () => {
    const chosen = picker.querySelector<HTMLElement>("option:checked");
    if (!chosen?.getAttribute("value")) return;
    for (const field of ["name", "phone", "address"] as const) {
      doc.querySelector<HTMLInputElement>(`#checkout-form [name=${field}]`)!.value = chosen.dataset[field] ?? "";
    }
  });
}
