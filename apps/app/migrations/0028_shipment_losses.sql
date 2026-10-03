CREATE TABLE `shipment_loss_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`loss_id` integer NOT NULL,
	`order_line_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`loss_id`) REFERENCES `shipment_losses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipment_loss_items_quantity_check" CHECK("shipment_loss_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_loss_items_loss_line_uidx` ON `shipment_loss_items` (`loss_id`,`order_line_id`);--> statement-breakpoint
CREATE INDEX `shipment_loss_items_line_idx` ON `shipment_loss_items` (`order_line_id`);--> statement-breakpoint
CREATE TABLE `shipment_losses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`shipment_id` integer NOT NULL,
	`loss_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`confirmed_at` integer NOT NULL,
	`actor` text NOT NULL,
	`goods_twd` integer NOT NULL,
	`standard_shipping_twd` integer NOT NULL,
	`large_shipping_twd` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_losses_shipment_key_uidx` ON `shipment_losses` (`shipment_id`,`loss_key`);--> statement-breakpoint
CREATE INDEX `shipment_losses_order_idx` ON `shipment_losses` (`order_id`);--> statement-breakpoint
-- 重建 refunds：新增原因 loss（CHECK 要改）與 shipment_loss_id。D1 上 PRAGMA foreign_keys 不能關，做法同 0021、0024、0025、0026：
-- 先備份到無外鍵的暫存表，砍掉舊表、建新表、把資料原樣（含編號）寫回，提交時沒有任何外鍵違規（refund_attempts 仍指向同編號的退款）。
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__refunds_backup` AS SELECT * FROM `refunds`;--> statement-breakpoint
CREATE TABLE `__refunds_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'refunds';--> statement-breakpoint
DROP TABLE `refunds`;--> statement-breakpoint
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
	`return_request_id` integer,
	`shipment_loss_id` integer,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancellation_request_id`) REFERENCES `cancellation_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_request_id`) REFERENCES `return_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipment_loss_id`) REFERENCES `shipment_losses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_gateway_refund_check" CHECK("refunds"."gateway_refund_id" <> ''),
	CONSTRAINT "refunds_status_check" CHECK("refunds"."status" IN ('pending', 'processing', 'unknown', 'failed', 'succeeded')),
	CONSTRAINT "refunds_reason_check" CHECK("refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success', 'cancellation', 'return', 'loss')),
	CONSTRAINT "refunds_amount_check" CHECK("refunds"."amount_twd" > 0 AND "refunds"."goods_twd" >= 0 AND "refunds"."shipping_twd" >= 0 AND "refunds"."goods_twd" + "refunds"."shipping_twd" = "refunds"."amount_twd")
);
--> statement-breakpoint
INSERT INTO `refunds`("id", "order_id", "payment_id", "reason", "gateway_refund_id", "amount_twd", "goods_twd", "shipping_twd", "status", "cancellation_request_id", "return_request_id", "created_at", "claimed_at", "settled_at") SELECT "id", "order_id", "payment_id", "reason", "gateway_refund_id", "amount_twd", "goods_twd", "shipping_twd", "status", "cancellation_request_id", "return_request_id", "created_at", "claimed_at", "settled_at" FROM `__refunds_backup`;--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__refunds_seq_backup`), 0)) WHERE `name` = 'refunds';--> statement-breakpoint
DROP TABLE `__refunds_backup`;--> statement-breakpoint
DROP TABLE `__refunds_seq_backup`;--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_gateway_refund_uidx` ON `refunds` (`gateway_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_cancellation_uidx` ON `refunds` (`cancellation_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_return_uidx` ON `refunds` (`return_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_loss_uidx` ON `refunds` (`shipment_loss_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_payment_reason_uidx` ON `refunds` (`payment_id`,`reason`) WHERE "refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success');