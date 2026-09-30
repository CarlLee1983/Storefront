CREATE TABLE `payment_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`gateway_payment_id` text NOT NULL,
	`outcome` text NOT NULL,
	`claim` text NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`gateway_payment_id` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_status_check" CHECK("payments"."status" IN ('pending', 'succeeded', 'failed', 'expired', 'refunded', 'refund_failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_gateway_payment_uidx` ON `payments` (`gateway_payment_id`);--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);