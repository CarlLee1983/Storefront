-- 回復 0033_low_stock_threshold：移除變體的低庫存門檻欄位與其部分索引。
-- 門檻只是後台提醒的設定（提醒由可售量即時推導，沒有另存狀態），丟棄不影響庫存與訂單，所以不設守門檢查；已設定的門檻會遺失。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0033_low_stock_threshold.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0033。
DROP INDEX `product_variants_low_stock_idx`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `low_stock_threshold`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0033_low_stock_threshold.sql';
