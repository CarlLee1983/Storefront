-- 回復 0021_shipments：回到「整單一次出貨」的舊模型，移除出貨批次。
-- 舊模型無法表達分批，守門檢查讓回復失敗的情況：
--   1. 有部分出貨的訂單，或有遷移補建（dispatch_key = 'legacy'）以外的批次：分批資料一旦移除就無法還原，須先人工確認可以捨棄；
--   2. 有 dispatch_key = 'legacy' 以外的庫存流水關聯批次（同上，由 1 涵蓋）。
-- 遷移補建的整單批次會搬回 orders.tracking_number、shipped_at（遷移前沒有出貨時間的舊單仍為 null）。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0021_shipments.down.sql` 執行；
-- 回復前須一併回復 App（舊 App 不認得部分出貨狀態與批次）。最後一句移除遷移紀錄，之後可重新套用 0021。
-- 若要連 0020 一起回復，接著執行 0020 的回復腳本。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `orders` WHERE `status` = 'partially_shipped') THEN 0
  WHEN EXISTS (SELECT 1 FROM `shipments` WHERE `dispatch_key` <> 'legacy') THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
-- 重建 orders 的方式同 0021（備份、砍表、建表、寫回，D1 不能關外鍵）；舊欄位 tracking_number、shipped_at 取自補建的整單批次
CREATE TABLE `__orders_backup` AS
SELECT ord.*, (SELECT shipment.`tracking_number` FROM `shipments` shipment WHERE shipment.`order_id` = ord.`id`) AS `tracking_number`,
  (SELECT shipment.`shipped_at` FROM `shipments` shipment WHERE shipment.`order_id` = ord.`id`) AS `shipped_at`
FROM `orders` ord;
--> statement-breakpoint
CREATE TABLE `__orders_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'orders';
--> statement-breakpoint
-- 庫存流水不能 UPDATE／DROP COLUMN 帶外鍵的欄位，所以重建（守門保證 shipment_id 全為 null）；trigger 與索引一併還原
CREATE TABLE `__old_stock_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`delta` integer NOT NULL,
	`on_hand_after` integer NOT NULL,
	`order_id` integer,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__old_stock_movements` SELECT `id`, `variant_id`, `kind`, `delta`, `on_hand_after`, `order_id`, `actor`, `reason`, `created_at` FROM `stock_movements`;
--> statement-breakpoint
DROP TABLE `stock_movements`;
--> statement-breakpoint
ALTER TABLE `__old_stock_movements` RENAME TO `stock_movements`;
--> statement-breakpoint
CREATE INDEX `stock_movements_variant_idx` ON `stock_movements` (`variant_id`,`id`);
--> statement-breakpoint
CREATE INDEX `stock_movements_order_idx` ON `stock_movements` (`order_id`);
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_update` BEFORE UPDATE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_delete` BEFORE DELETE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
--> statement-breakpoint
DROP TABLE `shipment_items`;
--> statement-breakpoint
DROP TABLE `shipments`;
--> statement-breakpoint
DROP TABLE `orders`;
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'pending_payment' NOT NULL,
	`total_twd` integer NOT NULL,
	`standard_shipping_fee_twd` integer DEFAULT 0 NOT NULL,
	`large_shipping_fee_twd` integer DEFAULT 0 NOT NULL,
	`shipping_name` text NOT NULL,
	`shipping_phone` text NOT NULL,
	`shipping_address` text NOT NULL,
	`payment_deadline` integer NOT NULL,
	`created_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`paid_by_payment_id` integer,
	`tracking_number` text,
	`shipped_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('pending_payment', 'paid', 'shipped', 'expired', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `orders` SELECT * FROM `__orders_backup`;
--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__orders_seq_backup`), 0)) WHERE `name` = 'orders';
--> statement-breakpoint
DROP TABLE `__orders_backup`;
--> statement-breakpoint
DROP TABLE `__orders_seq_backup`;
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_customer_idempotency_uidx` ON `orders` (`customer_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0021_shipments.sql';
