const priceFormat = new Intl.NumberFormat("zh-TW");

/**
 * 後台商品清單的「特價」欄：只有上架中且有原價才是特價商品；
 * 下架中的商品即使有原價，前台也不顯示，要明講，免得管理員以為它正在特價。
 */
export function saleStatusText(listed: boolean, compareAtPriceTwd: number | null): string {
  if (compareAtPriceTwd === null) return "—";
  const compareAt = `NT$ ${priceFormat.format(compareAtPriceTwd)}`;
  return listed ? `特價（原價 ${compareAt}）` : `原價 ${compareAt}（下架中，前台不顯示）`;
}
