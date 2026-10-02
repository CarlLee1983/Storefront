CREATE TABLE `contact_verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`verified_at` integer,
	`superseded_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_verifications_token_uidx` ON `contact_verifications` (`token`);--> statement-breakpoint
CREATE INDEX `contact_verifications_customer_idx` ON `contact_verifications` (`customer_id`,`verified_at`);--> statement-breakpoint
CREATE TABLE `mail_controls` (
	`id` integer PRIMARY KEY NOT NULL,
	`fail_deliveries` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mail_controls_check" CHECK("mail_controls"."id" = 1 AND "mail_controls"."fail_deliveries" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `mail_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`recipient_address` text NOT NULL,
	`status` text NOT NULL,
	`attempted_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `mail_messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mail_deliveries_status_check" CHECK("mail_deliveries"."status" IN ('delivered', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `mail_deliveries_message_idx` ON `mail_deliveries` (`message_id`);--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`verification_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verification_id`) REFERENCES `contact_verifications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mail_messages_customer_idx` ON `mail_messages` (`customer_id`,`id`);