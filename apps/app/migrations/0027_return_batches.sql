CREATE TABLE `return_request_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`order_line_id` integer NOT NULL,
	`shipment_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `return_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "return_request_batches_quantity_check" CHECK("return_request_batches"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `return_request_batches_request_line_shipment_uidx` ON `return_request_batches` (`request_id`,`order_line_id`,`shipment_id`);--> statement-breakpoint
CREATE INDEX `return_request_batches_shipment_idx` ON `return_request_batches` (`shipment_id`,`order_line_id`);