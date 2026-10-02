CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- 舊的整筆退款（狀態 refunded）改記成一筆全額成功的退款；付款狀態不再有 refunded／refund_failed（退款進度在 refunds），一律回到 succeeded。
INSERT INTO `refunds` (`id`, `payment_id`, `amount_twd`, `status`, `created_at`)
SELECT 'legacy_' || `id`, `id`, `amount_twd`, 'succeeded', COALESCE((SELECT MAX(`created_at`) FROM `events` WHERE `events`.`payment_id` = `payments`.`id` AND `events`.`type` = 'payment.refunded'), `created_at`)
FROM `payments` WHERE `status` = 'refunded';
--> statement-breakpoint
UPDATE `payments` SET `status` = 'succeeded' WHERE `status` IN ('refunded', 'refund_failed');
