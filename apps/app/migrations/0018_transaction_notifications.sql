ALTER TABLE `mail_deliveries` ADD `handled_by` text;--> statement-breakpoint
ALTER TABLE `mail_messages` ADD `event_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_event_key_uidx` ON `mail_messages` (`event_key`);