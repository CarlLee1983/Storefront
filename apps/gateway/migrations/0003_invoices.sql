CREATE TABLE `invoice_controls` (
	`id` integer PRIMARY KEY NOT NULL,
	`fail_next` integer DEFAULT 0 NOT NULL,
	`lose_next_response` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invoice_controls_check" CHECK("invoice_controls"."id" = 1 AND "invoice_controls"."fail_next" IN (0, 1) AND "invoice_controls"."lose_next_response" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_key` text NOT NULL,
	`merchant_reference` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`invoice_number` text NOT NULL,
	`issued_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_invoice_key_uidx` ON `invoices` (`invoice_key`);