-- 回復 0023_payment_reconcile：移除付款補查的待辦表（payment_reconcile_issues）與 payments.reconciled_at（最近一次補查時間）。
-- 待辦是衍生的處理紀錄，不影響付款與訂單；守門檢查讓回復失敗的情況：表內仍有開著的待辦（`resolved_at` 為空的列，與後台清單同一定義），須先處理或確認可以捨棄。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0023_payment_reconcile.down.sql` 執行；
-- 回復前須一併回復 App 與 Web（舊版不認得補查 RPC 與後台頁）。最後一句移除遷移紀錄，之後可重新套用 0023。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `payment_reconcile_issues` WHERE `resolved_at` IS NULL) THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `payment_reconcile_issues`;
--> statement-breakpoint
ALTER TABLE `payments` DROP COLUMN `reconciled_at`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0023_payment_reconcile.sql';
