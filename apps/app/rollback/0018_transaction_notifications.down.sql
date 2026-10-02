-- 回復 0018_transaction_notifications：移除信件的業務事件鍵與投遞的處理人欄位。
-- 已有交易通知（事件鍵）或手動重送的處理紀錄就無法無損還原（通知的冪等依據與處理紀錄會消失），
-- 守門檢查會讓整段失敗；要回復須先確認這些資料可以捨棄並清空。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0018_transaction_notifications.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0018。若要連 0017 一起回復，接著執行 0017 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `mail_messages` WHERE `event_key` IS NOT NULL)
  OR EXISTS (SELECT 1 FROM `mail_deliveries` WHERE `handled_by` IS NOT NULL)
  THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP INDEX `mail_messages_event_key_uidx`;
--> statement-breakpoint
ALTER TABLE `mail_messages` DROP COLUMN `event_key`;
--> statement-breakpoint
ALTER TABLE `mail_deliveries` DROP COLUMN `handled_by`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0018_transaction_notifications.sql';
