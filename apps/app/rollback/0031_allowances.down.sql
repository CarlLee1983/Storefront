-- 回復 0031_allowances：移除折讓嘗試紀錄（allowance_attempts），並把待折讓義務（allowance_obligations）還原成 0030 的結構（拿掉冪等鍵、狀態、折讓號碼與折讓時間）。
-- 守門檢查讓回復失敗的情況（資料會失真，須先確認可以捨棄）：任何已折讓的義務（發票服務已開立折讓，舊版無法表達），或任何折讓嘗試紀錄（含結果不明：發票服務那邊可能已折讓，捨棄紀錄會失去查證依據、補回後可能重複折讓）。
-- 其餘（從未送出過的待折讓義務）都由成功退款推得，捨棄狀態不遺失事實；義務本身保留。
-- 用法：先停止寫入並先回復 App 與 Web，再以 `wrangler d1 execute <DB> --file rollback/0031_allowances.down.sql` 執行；最後一句移除遷移紀錄，之後可重新套用 0031（舊義務會補成 `alw_legacy_<義務編號>` 的待折讓）。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM `allowance_obligations` WHERE `status` = 'issued') THEN 0
  WHEN EXISTS (SELECT 1 FROM `allowance_attempts`) THEN 0
  ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
DROP TABLE `allowance_attempts`;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__old_allowance_obligations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`amount_twd` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allowance_obligations_amount_check" CHECK("__old_allowance_obligations"."amount_twd" > 0)
);
--> statement-breakpoint
INSERT INTO `__old_allowance_obligations` (`id`, `refund_id`, `payment_id`, `order_id`, `amount_twd`, `created_at`)
SELECT `id`, `refund_id`, `payment_id`, `order_id`, `amount_twd`, `created_at` FROM `allowance_obligations`;
--> statement-breakpoint
DROP TABLE `allowance_obligations`;
--> statement-breakpoint
ALTER TABLE `__old_allowance_obligations` RENAME TO `allowance_obligations`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `allowance_obligations_refund_uidx` ON `allowance_obligations` (`refund_id`);
--> statement-breakpoint
CREATE INDEX `allowance_obligations_payment_idx` ON `allowance_obligations` (`payment_id`);
--> statement-breakpoint
CREATE INDEX `allowance_obligations_order_idx` ON `allowance_obligations` (`order_id`);
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0031_allowances.sql';
