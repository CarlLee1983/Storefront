-- 回復 0030_invoices：移除模擬發票（invoices、invoice_attempts）與待折讓義務（allowance_obligations）。
-- 守門檢查讓回復失敗的情況（資料會失真，須先確認可以捨棄）：任何已開立的發票（顧客已收到憑證，舊版無法表達）。
-- 其餘（待開立、失敗、結果不明的開立義務，與待折讓義務）都由收款與退款推得，捨棄不遺失事實；重新套用 0030 會從收款與成功退款補回。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0030_invoices.down.sql` 執行；最後一句移除遷移紀錄，之後可重新套用 0030。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `invoices` WHERE `status` = 'issued') THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `allowance_obligations`;
--> statement-breakpoint
DROP TABLE `invoice_attempts`;
--> statement-breakpoint
DROP TABLE `invoices`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0030_invoices.sql';
