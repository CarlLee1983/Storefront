-- 回復 0027_return_batches：移除自助退貨的批次對應表（return_request_batches）。
-- 守門檢查讓回復失敗的情況：任何批次對應列存在（自助申請的批次期限判斷依據，捨棄後無法再核對各批占用，須先確認可以捨棄）。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0027_return_batches.down.sql` 執行；最後一句移除遷移紀錄，之後可重新套用 0027。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `return_request_batches`) THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `return_request_batches`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0027_return_batches.sql';
