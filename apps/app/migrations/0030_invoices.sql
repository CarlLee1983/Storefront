CREATE TABLE `allowance_obligations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`amount_twd` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allowance_obligations_amount_check" CHECK("allowance_obligations"."amount_twd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowance_obligations_refund_uidx` ON `allowance_obligations` (`refund_id`);--> statement-breakpoint
CREATE INDEX `allowance_obligations_payment_idx` ON `allowance_obligations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `allowance_obligations_order_idx` ON `allowance_obligations` (`order_id`);--> statement-breakpoint
CREATE TABLE `invoice_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`code` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_attempts_action_check" CHECK("invoice_attempts"."action" IN ('send', 'verify')),
	CONSTRAINT "invoice_attempts_outcome_check" CHECK("invoice_attempts"."outcome" IN ('succeeded', 'failed', 'unknown', 'not_found'))
);
--> statement-breakpoint
CREATE INDEX `invoice_attempts_invoice_idx` ON `invoice_attempts` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`gateway_invoice_key` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invoice_number` text,
	`created_at` integer NOT NULL,
	`issued_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_status_check" CHECK("invoices"."status" IN ('pending', 'unknown', 'failed', 'issued')),
	CONSTRAINT "invoices_gateway_key_check" CHECK("invoices"."gateway_invoice_key" <> ''),
	CONSTRAINT "invoices_amount_check" CHECK("invoices"."amount_twd" > 0),
	CONSTRAINT "invoices_issued_check" CHECK(("invoices"."status" = 'issued') = ("invoices"."invoice_number" IS NOT NULL AND "invoices"."issued_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_payment_uidx` ON `invoices` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_gateway_key_uidx` ON `invoices` (`gateway_invoice_key`);--> statement-breakpoint
CREATE INDEX `invoices_order_idx` ON `invoices` (`order_id`);--> statement-breakpoint
-- 遷移前已成功的收款補開立義務（待開立），遷移前已成功的退款補待折讓義務；之後由程式寫入（見 `invoices/schema.ts`）。
INSERT INTO `invoices` (`order_id`, `payment_id`, `gateway_invoice_key`, `amount_twd`, `status`, `created_at`)
SELECT `order_id`, `id`, 'inv_legacy_' || `id`, `amount_twd`, 'pending', `created_at` FROM `payments` WHERE `status` = 'succeeded';
--> statement-breakpoint
INSERT INTO `allowance_obligations` (`refund_id`, `payment_id`, `order_id`, `amount_twd`, `created_at`)
SELECT `id`, `payment_id`, `order_id`, `amount_twd`, COALESCE(`settled_at`, `created_at`) FROM `refunds` WHERE `status` = 'succeeded';
