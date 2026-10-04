CREATE TABLE `shipment_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shipment_id` integer NOT NULL,
	`order_line_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipment_items_quantity_check" CHECK("shipment_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_items_shipment_line_uidx` ON `shipment_items` (`shipment_id`,`order_line_id`);--> statement-breakpoint
CREATE INDEX `shipment_items_line_idx` ON `shipment_items` (`order_line_id`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`dispatch_key` text NOT NULL,
	`request_hash` text,
	`tracking_number` text,
	`appointment_start` integer,
	`appointment_end` integer,
	`shipped_at` integer,
	`actor` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipments_appointment_check" CHECK(("shipments"."appointment_start" IS NULL) = ("shipments"."appointment_end" IS NULL) AND ("shipments"."appointment_start" IS NULL OR "shipments"."appointment_end" > "shipments"."appointment_start"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_order_key_uidx` ON `shipments` (`order_id`,`dispatch_key`);--> statement-breakpoint
-- 舊的已出貨訂單（#111 之前整單出貨）補一批整單批次：物流單號與出貨時間只照搬舊欄位，舊訂單沒有的資訊（出貨時間、預約）留空，不編造。
-- 那些訂單當時已扣過實體在庫（0020 的流水），所以補建批次不動庫存也不寫流水。
INSERT INTO `shipments` (`order_id`, `dispatch_key`, `tracking_number`, `shipped_at`, `actor`)
SELECT `id`, 'legacy:0021', `tracking_number`, `shipped_at`, 'system:0021_shipments' FROM `orders` WHERE `status` = 'shipped';--> statement-breakpoint
INSERT INTO `shipment_items` (`shipment_id`, `order_line_id`, `quantity`)
SELECT shipment.`id`, line.`id`, line.`quantity` FROM `shipments` shipment JOIN `order_lines` line ON line.`order_id` = shipment.`order_id` WHERE shipment.`dispatch_key` = 'legacy:0021';--> statement-breakpoint
-- 重建 orders：放寬狀態 CHECK（新增 partially_shipped），並移除已搬到批次的 tracking_number、shipped_at。
-- D1 上 PRAGMA foreign_keys 不能關，所以不用「建新表、改名」：先把資料備份到無外鍵的暫存表，砍掉舊表、建新表、再把資料原樣（含編號）
-- 寫回；寫回父列時延後檢查的外鍵違規即被消除，並還原 AUTOINCREMENT 計數，提交時沒有任何違規。
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__orders_backup` AS SELECT * FROM `orders`;--> statement-breakpoint
CREATE TABLE `__orders_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'orders';--> statement-breakpoint
DROP TABLE `orders`;--> statement-breakpoint
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
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('pending_payment', 'paid', 'partially_shipped', 'shipped', 'expired', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `orders`("id", "customer_id", "status", "total_twd", "standard_shipping_fee_twd", "large_shipping_fee_twd", "shipping_name", "shipping_phone", "shipping_address", "payment_deadline", "created_at", "idempotency_key", "request_hash", "paid_by_payment_id") SELECT "id", "customer_id", "status", "total_twd", "standard_shipping_fee_twd", "large_shipping_fee_twd", "shipping_name", "shipping_phone", "shipping_address", "payment_deadline", "created_at", "idempotency_key", "request_hash", "paid_by_payment_id" FROM `__orders_backup`;--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__orders_seq_backup`), 0)) WHERE `name` = 'orders';--> statement-breakpoint
DROP TABLE `__orders_backup`;--> statement-breakpoint
DROP TABLE `__orders_seq_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_customer_idempotency_uidx` ON `orders` (`customer_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `shipment_id` integer REFERENCES shipments(id);--> statement-breakpoint
CREATE INDEX `stock_movements_shipment_idx` ON `stock_movements` (`shipment_id`);