-- 回復 0025_cancellations：移除取消申請（cancellation_requests、cancellation_request_items），refunds 改回沒有 cancellation_request_id 與 cancellation 原因。
-- 守門檢查讓回復失敗的情況（資料會失真，須先確認可以捨棄或人工處理）：任何取消申請存在（含待審；核准的取消已釋放保留、停止履約，回復後舊版無法表達），
-- 或任何原因為 cancellation 的退款。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0025_cancellations.down.sql` 執行；
-- 已寄出的取消審核信件保留在信箱（舊版顯示為一般通知）。最後一句移除遷移紀錄，之後可重新套用 0025。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `cancellation_requests`) THEN 0
  WHEN EXISTS (SELECT 1 FROM `refunds` WHERE `reason` = 'cancellation') THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `__refunds_backup` AS SELECT * FROM `refunds`;
--> statement-breakpoint
CREATE TABLE `__refunds_seq_backup` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'refunds';
--> statement-breakpoint
DROP TABLE `refunds`;
--> statement-breakpoint
DROP TABLE `cancellation_request_items`;
--> statement-breakpoint
DROP TABLE `cancellation_requests`;
--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`reason` text NOT NULL,
	`gateway_refund_id` text NOT NULL,
	`amount_twd` integer NOT NULL,
	`goods_twd` integer NOT NULL,
	`shipping_twd` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_gateway_refund_check" CHECK("refunds"."gateway_refund_id" <> ''),
	CONSTRAINT "refunds_status_check" CHECK("refunds"."status" IN ('pending', 'processing', 'unknown', 'failed', 'succeeded')),
	CONSTRAINT "refunds_reason_check" CHECK("refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success')),
	CONSTRAINT "refunds_amount_check" CHECK("refunds"."amount_twd" > 0 AND "refunds"."goods_twd" >= 0 AND "refunds"."shipping_twd" >= 0 AND "refunds"."goods_twd" + "refunds"."shipping_twd" = "refunds"."amount_twd")
);
--> statement-breakpoint
INSERT INTO `refunds` (`id`, `order_id`, `payment_id`, `reason`, `gateway_refund_id`, `amount_twd`, `goods_twd`, `shipping_twd`, `status`, `created_at`, `claimed_at`, `settled_at`)
SELECT `id`, `order_id`, `payment_id`, `reason`, `gateway_refund_id`, `amount_twd`, `goods_twd`, `shipping_twd`, `status`, `created_at`, `claimed_at`, `settled_at` FROM `__refunds_backup`;
--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `__refunds_seq_backup`), 0)) WHERE `name` = 'refunds';
--> statement-breakpoint
DROP TABLE `__refunds_backup`;
--> statement-breakpoint
DROP TABLE `__refunds_seq_backup`;
--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);
--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_gateway_refund_uidx` ON `refunds` (`gateway_refund_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_payment_reason_uidx` ON `refunds` (`payment_id`,`reason`) WHERE "refunds"."reason" IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success');
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0025_cancellations.sql';
