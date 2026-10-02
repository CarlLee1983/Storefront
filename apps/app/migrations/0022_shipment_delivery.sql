CREATE TABLE `shipment_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shipment_id` integer NOT NULL,
	`event_key` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`actor` text NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipment_events_kind_check" CHECK("shipment_events"."kind" IN ('delivered', 'delivery_failed', 'redelivery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_events_shipment_key_uidx` ON `shipment_events` (`shipment_id`,`event_key`);--> statement-breakpoint
ALTER TABLE `shipments` ADD `delivery_status` text DEFAULT 'in_transit' NOT NULL;--> statement-breakpoint
ALTER TABLE `shipments` ADD `delivered_at` integer;