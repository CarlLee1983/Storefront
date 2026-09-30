CREATE TABLE `order_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_twd` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_lines_quantity_check" CHECK("order_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_lines_order_product_uidx` ON `order_lines` (`order_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `order_lines_product_idx` ON `order_lines` (`product_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'pending_payment' NOT NULL,
	`total_twd` integer NOT NULL,
	`shipping_name` text NOT NULL,
	`shipping_phone` text NOT NULL,
	`shipping_address` text NOT NULL,
	`payment_deadline` integer NOT NULL,
	`created_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('pending_payment', 'paid', 'shipped', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_customer_idempotency_uidx` ON `orders` (`customer_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE TABLE `clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`hwm` integer NOT NULL
);
