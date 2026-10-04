-- 回復 0017_address_book：移除地址簿資料表。
-- 表內一旦有地址就無法無損還原（顧客保存的收件資訊會消失；訂單上的收件資訊是快照，不受影響），
-- 守門檢查會讓整段失敗；要回復須先確認這些資料可以捨棄並清空。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0017_address_book.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0017。若要連 0016 一起回復，接著執行 0016 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `customer_addresses`) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `customer_addresses`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0017_address_book.sql';
