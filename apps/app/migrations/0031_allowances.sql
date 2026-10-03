PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_allowance_obligations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`amount_twd` integer NOT NULL,
	`created_at` integer NOT NULL,
	`gateway_allowance_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`allowance_number` text,
	`issued_at` integer,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allowance_obligations_amount_check" CHECK("__new_allowance_obligations"."amount_twd" > 0),
	CONSTRAINT "allowance_obligations_status_check" CHECK("__new_allowance_obligations"."status" IN ('pending', 'unknown', 'failed', 'issued')),
	CONSTRAINT "allowance_obligations_gateway_key_check" CHECK("__new_allowance_obligations"."gateway_allowance_key" <> ''),
	CONSTRAINT "allowance_obligations_issued_check" CHECK(("__new_allowance_obligations"."status" = 'issued') = ("__new_allowance_obligations"."allowance_number" IS NOT NULL AND "__new_allowance_obligations"."issued_at" IS NOT NULL))
);
--> statement-breakpoint
-- 0030 已存在的待折讓義務沿用「待折讓」狀態，冪等鍵補成 alw_legacy_<義務編號>（之後永不更改），之後由管理員逐筆補辦。
INSERT INTO `__new_allowance_obligations`("id", "refund_id", "payment_id", "order_id", "amount_twd", "created_at", "gateway_allowance_key", "status") SELECT "id", "refund_id", "payment_id", "order_id", "amount_twd", "created_at", 'alw_legacy_' || "id", 'pending' FROM `allowance_obligations`;--> statement-breakpoint
DROP TABLE `allowance_obligations`;--> statement-breakpoint
ALTER TABLE `__new_allowance_obligations` RENAME TO `allowance_obligations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `allowance_obligations_refund_uidx` ON `allowance_obligations` (`refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `allowance_obligations_gateway_key_uidx` ON `allowance_obligations` (`gateway_allowance_key`);--> statement-breakpoint
CREATE INDEX `allowance_obligations_payment_idx` ON `allowance_obligations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `allowance_obligations_order_idx` ON `allowance_obligations` (`order_id`);--> statement-breakpoint
CREATE TABLE `allowance_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`allowance_id` integer NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`code` text,
	FOREIGN KEY (`allowance_id`) REFERENCES `allowance_obligations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allowance_attempts_action_check" CHECK("allowance_attempts"."action" IN ('send', 'verify')),
	CONSTRAINT "allowance_attempts_outcome_check" CHECK("allowance_attempts"."outcome" IN ('succeeded', 'failed', 'unknown', 'not_found'))
);
--> statement-breakpoint
CREATE INDEX `allowance_attempts_allowance_idx` ON `allowance_attempts` (`allowance_id`);
