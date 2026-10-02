-- 回復 0015_product_info：移除商品的尺寸、材質與保養資訊。
-- 這三欄一旦有內容就無法無損還原，守門檢查會讓整段失敗；要回復須先確認這些資訊可以捨棄並清空。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0015_product_info.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0015。若要連 0014 一起回復，接著執行 0014 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `products` WHERE `dimensions` <> '' OR `material` <> '' OR `care` <> '')
  THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `dimensions`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `material`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `care`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0015_product_info.sql';
