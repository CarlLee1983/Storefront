-- 回復 0019_shipping_fees：移除配送類型與運費快照欄位、費率資料表。
-- 一旦有訂單收過運費、或有變體／訂單明細是大型配送，就無法無損還原（訂單總額含運費，卻會失去各類運費與類型的拆分），
-- 守門檢查會讓整段失敗；要回復須先確認這些資料可以捨棄。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0019_shipping_fees.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0019。若要連 0018 一起回復，接著執行 0018 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `orders` WHERE `standard_shipping_fee_twd` <> 0 OR `large_shipping_fee_twd` <> 0)
  OR EXISTS (SELECT 1 FROM `product_variants` WHERE `delivery_type` <> 'standard')
  OR EXISTS (SELECT 1 FROM `order_lines` WHERE `delivery_type` <> 'standard')
  THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `large_shipping_fee_twd`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `standard_shipping_fee_twd`;
--> statement-breakpoint
ALTER TABLE `order_lines` DROP COLUMN `delivery_type`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `delivery_type`;
--> statement-breakpoint
DROP TABLE `shipping_rates`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0019_shipping_fees.sql';
