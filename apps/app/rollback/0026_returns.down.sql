-- 回復 0026_returns：移除退貨申請（return_requests、return_request_items）與不可售數量，refunds 改回沒有 return_request_id 與 return 原因，庫存流水去掉不可售欄位。
-- 守門檢查讓回復失敗的情況（資料會失真，須先確認可以捨棄或人工處理）：任何退貨申請存在（含待審與已核准未收回；收回與檢查已改變實體與不可售），
-- 任何變體的不可售數量大於 0，任何不可售相關的庫存流水（退貨收回、檢查合格、報廢），或任何原因為 return 的退款。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0026_returns.down.sql` 執行；
-- 已寄出的退貨審核信件保留在信箱（舊版顯示為一般通知）。最後一句移除遷移紀錄，之後可重新套用 0026。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `return_requests`) THEN 0
  WHEN EXISTS (SELECT 1 FROM `product_variants` WHERE `unavailable` <> 0) THEN 0
  WHEN EXISTS (SELECT 1 FROM `stock_movements` WHERE `kind` IN ('return_received', 'return_inspected', 'scrap') OR `unavailable_delta` <> 0 OR `return_request_id` IS NOT NULL) THEN 0
  WHEN EXISTS (SELECT 1 FROM `refunds` WHERE `reason` = 'return') THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
-- 庫存流水帶外鍵的欄位不能 DROP COLUMN，所以重建（守門保證新欄位都是預設值）；trigger 與索引一併還原
CREATE TABLE `__old_stock_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`delta` integer NOT NULL,
	`on_hand_after` integer NOT NULL,
	`order_id` integer,
	`shipment_id` integer,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__old_stock_movements` SELECT `id`, `variant_id`, `kind`, `delta`, `on_hand_after`, `order_id`, `shipment_id`, `actor`, `reason`, `created_at` FROM `stock_movements`;
--> statement-breakpoint
DROP TABLE `stock_movements`;
--> statement-breakpoint
ALTER TABLE `__old_stock_movements` RENAME TO `stock_movements`;
--> statement-breakpoint
CREATE INDEX `stock_movements_variant_idx` ON `stock_movements` (`variant_id`,`id`);
--> statement-breakpoint
CREATE INDEX `stock_movements_order_idx` ON `stock_movements` (`order_id`);
--> statement-breakpoint
CREATE INDEX `stock_movements_shipment_idx` ON `stock_movements` (`shipment_id`);
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_update` BEFORE UPDATE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_delete` BEFORE DELETE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `unavailable`;
--> statement-breakpoint
CREATE TABLE `__refunds_backup` AS SELECT * FROM `refunds`;
--> statement-breakpoint
CREATE TABLE `__refunds_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'refunds';
--> statement-breakpoint
DROP TABLE `refunds`;
--> statement-breakpoint
DROP TABLE `return_request_items`;
--> statement-breakpoint
DROP TABLE `return_requests`;
--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`reason` text NOT NULL,
	`gateway_refund_id` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`goods_twd` integer NOT NULL,
	`shipping_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cancellation_request_id` integer,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancellation_request_id`) REFERENCES `cancellation_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_gateway_refund_check" CHECK("refunds"."gateway_refund_id" <> ''),
	CONSTRAINT "refunds_status_check" CHECK("refunds"."status" IN ('pending', 'processing', 'unknown', 'failed', 'succeeded')),
	CONSTRAINT "refunds_reason_check" CHECK("refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success', 'cancellation')),
	CONSTRAINT "refunds_amount_check" CHECK("refunds"."amount_twd" > 0 AND "refunds"."goods_twd" >= 0 AND "refunds"."shipping_twd" >= 0 AND "refunds"."goods_twd" + "refunds"."shipping_twd" = "refunds"."amount_twd")
);
--> statement-breakpoint
INSERT INTO `refunds` (`id`, `order_id`, `payment_id`, `reason`, `gateway_refund_id`, `amount_twd`, `goods_twd`, `shipping_twd`, `status`, `cancellation_request_id`, `created_at`, `claimed_at`, `settled_at`)
SELECT `id`, `order_id`, `payment_id`, `reason`, `gateway_refund_id`, `amount_twd`, `goods_twd`, `shipping_twd`, `status`, `cancellation_request_id`, `created_at`, `claimed_at`, `settled_at` FROM `__refunds_backup`;
--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__refunds_seq_backup`), 0)) WHERE `name` = 'refunds';
--> statement-breakpoint
DROP TABLE `__refunds_backup`;
--> statement-breakpoint
DROP TABLE `__refunds_seq_backup`;
--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);
--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_gateway_refund_uidx` ON `refunds` (`gateway_refund_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_cancellation_uidx` ON `refunds` (`cancellation_request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_payment_reason_uidx` ON `refunds` (`payment_id`,`reason`) WHERE "refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success');
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0026_returns.sql';
