-- 回復 0032_order_search_notes：移除客服備註（order_notes，連同只增不改的 trigger）、庫存流水的防覆蓋 trigger（stock_movements_no_replace）與訂單查找用的兩個索引（orders_status_idx、orders_created_idx）。
-- 守門檢查讓回復失敗的情況：任何客服備註存在（備註只增不改不刪，是營運紀錄，一旦丟棄無法重建；要回復須先匯出並確認可以捨棄）。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0032_order_search_notes.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0032。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `order_notes`) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TRIGGER `stock_movements_no_replace`;
--> statement-breakpoint
DROP TABLE `order_notes`;
--> statement-breakpoint
DROP INDEX `orders_status_idx`;
--> statement-breakpoint
DROP INDEX `orders_created_idx`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0032_order_search_notes.sql';
