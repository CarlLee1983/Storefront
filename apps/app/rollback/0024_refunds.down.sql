-- 回復 0024_refunds：把逐筆退款（refunds、refund_attempts）改回付款上的單一退款結果（payments.status 的 refunded／refund_failed 與 refund_reason、refund_at）。
-- 舊模型只能表達「一筆付款一次整筆退款」，守門檢查讓回復失敗的情況（資料會失真，須先確認可以捨棄或人工處理）：
-- 任何退款嘗試紀錄（refund_attempts，代表 0024 之後有人操作過退款）、不是 succeeded／unknown／failed 的退款（尚未送出、進行中）、
-- 同一筆付款有多筆退款，或退款金額不等於付款金額（部分退款）。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0024_refunds.down.sql` 執行；
-- 已寄出的 refund_succeeded 信件保留在信箱（舊版顯示為一般通知）。最後一句移除遷移紀錄，之後可重新套用 0024。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `refund_attempts`) THEN 0
  WHEN EXISTS (SELECT 1 FROM `refunds` WHERE `status` NOT IN ('succeeded', 'unknown', 'failed')) THEN 0
  WHEN EXISTS (SELECT 1 FROM `refunds` GROUP BY `payment_id` HAVING count(*) > 1) THEN 0
  WHEN EXISTS (SELECT 1 FROM `refunds` r JOIN `payments` p ON p.`id` = r.`payment_id` WHERE r.`amount_twd` <> p.`amount_twd`) THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `__payments_backup` AS
SELECT p.*,
  CASE r.`status` WHEN 'succeeded' THEN 'refunded' WHEN 'failed' THEN 'refund_failed' WHEN 'unknown' THEN 'refund_failed' ELSE p.`status` END AS `new_status`,
  r.`reason` AS `refund_reason`,
  COALESCE(r.`settled_at`, r.`created_at`) AS `refund_at`
FROM `payments` p LEFT JOIN `refunds` r ON r.`payment_id` = p.`id`;
--> statement-breakpoint
CREATE TABLE `__payments_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'payments';
--> statement-breakpoint
DROP TABLE `refund_attempts`;
--> statement-breakpoint
DROP TABLE `refunds`;
--> statement-breakpoint
DROP TABLE `payments`;
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`gateway_payment_id` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`refund_reason` text,
	`refund_at` integer,
	`reconciled_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_status_check" CHECK("payments"."status" IN ('pending', 'succeeded', 'failed', 'expired', 'refunded', 'refund_failed'))
);
--> statement-breakpoint
INSERT INTO `payments` (`id`, `order_id`, `gateway_payment_id`, `amount_twd`, `status`, `created_at`, `expires_at`, `refund_reason`, `refund_at`, `reconciled_at`)
SELECT `id`, `order_id`, `gateway_payment_id`, `amount_twd`, `new_status`, `created_at`, `expires_at`, `refund_reason`, `refund_at`, `reconciled_at` FROM `__payments_backup`;
--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__payments_seq_backup`), 0)) WHERE `name` = 'payments';
--> statement-breakpoint
DROP TABLE `__payments_backup`;
--> statement-breakpoint
DROP TABLE `__payments_seq_backup`;
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_gateway_payment_uidx` ON `payments` (`gateway_payment_id`);
--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0024_refunds.sql';
