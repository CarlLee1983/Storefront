CREATE TABLE `cancellation_request_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`order_line_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `cancellation_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cancellation_request_items_quantity_check" CHECK("cancellation_request_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cancellation_request_items_request_line_uidx` ON `cancellation_request_items` (`request_id`,`order_line_id`);--> statement-breakpoint
CREATE INDEX `cancellation_request_items_line_idx` ON `cancellation_request_items` (`order_line_id`);--> statement-breakpoint
CREATE TABLE `cancellation_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`decision_note` text,
	`goods_twd` integer,
	`standard_shipping_twd` integer,
	`large_shipping_twd` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cancellation_requests_status_check" CHECK("cancellation_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "cancellation_requests_decision_check" CHECK(("cancellation_requests"."status" = 'pending') = ("cancellation_requests"."decided_at" IS NULL) AND ("cancellation_requests"."status" = 'approved') = ("cancellation_requests"."goods_twd" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cancellation_requests_order_key_uidx` ON `cancellation_requests` (`order_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `cancellation_requests_status_idx` ON `cancellation_requests` (`status`);--> statement-breakpoint
-- 重建 refunds：新增原因 cancellation（CHECK 要改）與 cancellation_request_id。D1 上 PRAGMA foreign_keys 不能關，做法同 0021、0024：
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
INSERT INTO `refunds`("id", "order_id", "payment_id", "reason", "gateway_refund_id", "amount_twd", "goods_twd", "shipping_twd", "status", "created_at", "claimed_at", "settled_at") SELECT "id", "order_id", "payment_id", "reason", "gateway_refund_id", "amount_twd", "goods_twd", "shipping_twd", "status", "created_at", "claimed_at", "settled_at" FROM `__refunds_backup`;--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__refunds_seq_backup`), 0)) WHERE `name` = 'refunds';--> statement-breakpoint
DROP TABLE `__refunds_backup`;--> statement-breakpoint
DROP TABLE `__refunds_seq_backup`;--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_gateway_refund_uidx` ON `refunds` (`gateway_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_cancellation_uidx` ON `refunds` (`cancellation_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_payment_reason_uidx` ON `refunds` (`payment_id`,`reason`) WHERE "refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success');
