-- 回復 0020_stock_ledger：回到「付款時扣在庫」的舊語意，並移除庫存流水。
-- 舊語意下，在庫數 = 實際在庫 − 已付款未出貨，所以回復時對目前每張「已付款」訂單的明細扣回在庫數
-- （這同時涵蓋遷移前的舊單與遷移後才付款的新單）。守門檢查讓回復失敗的情況：
--   1. 流水裡有遷移以外的紀錄（管理員調整或交運扣庫）：流水一旦移除就無法稽核，須先確認可以捨棄；
--   2. 扣回後任一變體在庫數會小於 0（舊語意下不可能發生，表示資料需要先人工處理）。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0020_stock_ledger.down.sql` 執行；
-- 回復前須一併回復 App（舊 App 不認得已付款保留）。最後一句移除遷移紀錄，之後可重新套用 0020。
-- 若要連 0019 一起回復，接著執行 0019 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `stock_movements` WHERE `kind` <> 'migration') THEN 0
  WHEN EXISTS (
    SELECT 1 FROM `product_variants` variant
    WHERE variant.`on_hand` < COALESCE((
      SELECT SUM(line.`quantity`) FROM `order_lines` line JOIN `orders` ord ON ord.`id` = line.`order_id`
      WHERE ord.`status` = 'paid' AND line.`variant_id` = variant.`id`
    ), 0)
  ) THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
UPDATE `product_variants`
SET `on_hand` = `on_hand` - (
  SELECT SUM(line.`quantity`) FROM `order_lines` line JOIN `orders` ord ON ord.`id` = line.`order_id`
  WHERE ord.`status` = 'paid' AND line.`variant_id` = `product_variants`.`id`
)
WHERE `id` IN (SELECT line.`variant_id` FROM `order_lines` line JOIN `orders` ord ON ord.`id` = line.`order_id` WHERE ord.`status` = 'paid');
--> statement-breakpoint
DROP TABLE `stock_movements`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0020_stock_ledger.sql';
