-- 回復 0016_contact_mailbox：移除聯絡 email 驗證、模擬信箱與投遞紀錄的資料表。
-- 這些表一旦有資料（驗證請求、信件、投遞紀錄；不含演練控制）就無法無損還原，且顧客已驗證的聯絡 email 會消失，
-- 守門檢查會讓整段失敗；要回復須先確認這些資料可以捨棄並清空。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0016_contact_mailbox.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0016。若要連 0015 一起回復，接著執行 0015 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `contact_verifications`)
  OR EXISTS (SELECT 1 FROM `mail_messages`)
  OR EXISTS (SELECT 1 FROM `mail_deliveries`)
  THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `mail_deliveries`;
--> statement-breakpoint
DROP TABLE `mail_messages`;
--> statement-breakpoint
DROP TABLE `contact_verifications`;
--> statement-breakpoint
DROP TABLE `mail_controls`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0016_contact_mailbox.sql';
