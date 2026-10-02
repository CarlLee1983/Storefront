-- 回復 0014_variant_options：移除選項維度、選項值、停賣時間、變體圖片與訂單明細的變體選項快照。
-- 這些欄位一旦有實際內容（商品設了選項、變體有選項值或被停賣或指定圖片、訂單明細有選項快照）就無法無損還原，
-- 守門檢查會讓整段失敗；要回復須先處理這些資料。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0014_variant_options.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0014。若要連 0013 一起回復，接著執行 0013 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `products` WHERE `option1_name` <> '' OR `option2_name` <> '')
  OR EXISTS (SELECT 1 FROM `product_variants` WHERE `option1_value` <> '' OR `option2_value` <> '' OR `discontinued_at` IS NOT NULL OR `image_id` IS NOT NULL)
  OR EXISTS (SELECT 1 FROM `order_lines` WHERE `variant_label` <> '')
  THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP INDEX `product_variants_options_uidx`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `option1_value`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `option2_value`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `discontinued_at`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `image_id`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `option1_name`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `option2_name`;
--> statement-breakpoint
ALTER TABLE `order_lines` DROP COLUMN `variant_label`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0014_variant_options.sql';
