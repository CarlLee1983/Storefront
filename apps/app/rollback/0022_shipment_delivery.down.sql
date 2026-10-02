-- 回復 0022_shipment_delivery：移除物流回報事件（shipment_events）與批次上的配送進度、實際送達時間。
-- 這些資料移除後無法還原，守門檢查讓回復失敗的情況：已有任何物流回報事件，或任一批次不是預設的 in_transit（須先人工確認可以捨棄）。
-- 已寄出的送達／配送失敗通知（mail_messages）不屬於這支遷移，原樣保留。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0022_shipment_delivery.down.sql` 執行；
-- 回復前須一併回復 App（舊 App 不認得送達進度）。最後一句移除遷移紀錄，之後可重新套用 0022。
-- 若要連 0021 一起回復，接著執行 0021 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `shipment_events`) THEN 0
  WHEN EXISTS (SELECT 1 FROM `shipments` WHERE `delivery_status` <> 'in_transit' OR `delivered_at` IS NOT NULL) THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `shipment_events`;
--> statement-breakpoint
ALTER TABLE `shipments` DROP COLUMN `delivered_at`;
--> statement-breakpoint
ALTER TABLE `shipments` DROP COLUMN `delivery_status`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0022_shipment_delivery.sql';
