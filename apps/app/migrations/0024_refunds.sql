CREATE TABLE `refund_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`code` text,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refund_attempts_action_check" CHECK("refund_attempts"."action" IN ('send', 'verify')),
	CONSTRAINT "refund_attempts_outcome_check" CHECK("refund_attempts"."outcome" IN ('succeeded', 'failed', 'unknown', 'not_found'))
);
--> statement-breakpoint
CREATE INDEX `refund_attempts_refund_idx` ON `refund_attempts` (`refund_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`reason` text NOT NULL,
	`gateway_refund_id` text DEFAULT '' NOT NULL,
	`amount_twd` integer NOT NULL,
	`goods_twd` integer NOT NULL,
	`shipping_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_status_check" CHECK("refunds"."status" IN ('pending', 'processing', 'unknown', 'failed', 'succeeded')),
	CONSTRAINT "refunds_reason_check" CHECK("refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success')),
	CONSTRAINT "refunds_amount_check" CHECK("refunds"."amount_twd" > 0 AND "refunds"."goods_twd" >= 0 AND "refunds"."shipping_twd" >= 0 AND "refunds"."goods_twd" + "refunds"."shipping_twd" = "refunds"."amount_twd")
);
--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_gateway_refund_uidx` ON `refunds` (`gateway_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_payment_reason_uidx` ON `refunds` (`payment_id`,`reason`) WHERE "refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success');--> statement-breakpoint
-- 舊的整筆退款結果（payments.status 為 refunded／refund_failed）搬進逐筆退款：金額取付款實收，拆成商品款與訂單的運費快照；
-- 原因沿用 refund_reason（沒有時照 refundReasonFor 的規則由訂單狀態推得），時間沿用 refund_at。refunded → succeeded。
-- 舊的 refund_failed 分不出是閘道明確失敗還是結果不明（舊版逾時也記成 refund_failed，閘道可能其實已退款），所以一律搬成 unknown：
-- 重試時先向閘道查證（gateway_refund_id 為 legacy_<閘道付款 ID>，對得上閘道 0002 搬來的退款），確認沒退才送出。
INSERT INTO `refunds` (`order_id`, `payment_id`, `reason`, `gateway_refund_id`, `amount_twd`, `goods_twd`, `shipping_twd`, `status`, `created_at`, `settled_at`)
SELECT p.`order_id`, p.`id`,
  COALESCE(p.`refund_reason`, CASE o.`status` WHEN 'expired' THEN 'late_success_unreclaimable' WHEN 'cancelled' THEN 'cancelled_order' ELSE 'duplicate_success' END),
  'legacy_' || p.`gateway_payment_id`,
  p.`amount_twd`,
  p.`amount_twd` - MIN(o.`standard_shipping_fee_twd` + o.`large_shipping_fee_twd`, p.`amount_twd`),
  MIN(o.`standard_shipping_fee_twd` + o.`large_shipping_fee_twd`, p.`amount_twd`),
  CASE p.`status` WHEN 'refunded' THEN 'succeeded' ELSE 'unknown' END,
  COALESCE(p.`refund_at`, p.`created_at`),
  CASE p.`status` WHEN 'refunded' THEN COALESCE(p.`refund_at`, p.`created_at`) END
FROM `payments` p JOIN `orders` o ON o.`id` = p.`order_id`
WHERE p.`status` IN ('refunded', 'refund_failed');--> statement-breakpoint
-- 重建 payments：付款狀態不再有 refunded／refund_failed（退款不改付款狀態，進度在 refunds），並移除搬走的 refund_reason、refund_at。
-- D1 上 PRAGMA foreign_keys 不能關，做法同 0021：先備份到無外鍵的暫存表，砍掉舊表、建新表、把資料原樣（含編號）寫回，提交時沒有任何外鍵違規。
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__payments_backup` AS SELECT * FROM `payments`;--> statement-breakpoint
CREATE TABLE `__payments_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'payments';--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`gateway_payment_id` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`reconciled_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_status_check" CHECK("payments"."status" IN ('pending', 'succeeded', 'failed', 'expired'))
);
--> statement-breakpoint
INSERT INTO `payments`("id", "order_id", "gateway_payment_id", "amount_twd", "status", "created_at", "expires_at", "reconciled_at") SELECT "id", "order_id", "gateway_payment_id", "amount_twd", CASE WHEN "status" IN ('refunded', 'refund_failed') THEN 'succeeded' ELSE "status" END, "created_at", "expires_at", "reconciled_at" FROM `__payments_backup`;--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__payments_seq_backup`), 0)) WHERE `name` = 'payments';--> statement-breakpoint
DROP TABLE `__payments_backup`;--> statement-breakpoint
DROP TABLE `__payments_seq_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_gateway_payment_uidx` ON `payments` (`gateway_payment_id`);--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);
