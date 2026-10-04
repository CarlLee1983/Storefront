CREATE TABLE `allowance_controls` (
	`id` integer PRIMARY KEY NOT NULL,
	`fail_next` integer DEFAULT 0 NOT NULL,
	`lose_next_response` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "allowance_controls_check" CHECK("allowance_controls"."id" = 1 AND "allowance_controls"."fail_next" IN (0, 1) AND "allowance_controls"."lose_next_response" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `allowances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`allowance_key` text NOT NULL,
	`invoice_key` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`allowance_number` text NOT NULL,
	`issued_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowances_allowance_key_uidx` ON `allowances` (`allowance_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `allowances_allowance_number_uidx` ON `allowances` (`allowance_number`);