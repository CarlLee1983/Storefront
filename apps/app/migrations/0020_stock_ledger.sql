CREATE TABLE `stock_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`delta` integer NOT NULL,
	`on_hand_after` integer NOT NULL,
	`order_id` integer,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_movements_variant_idx` ON `stock_movements` (`variant_id`,`id`);--> statement-breakpoint
CREATE INDEX `stock_movements_order_idx` ON `stock_movements` (`order_id`);--> statement-breakpoint
-- 流水只增不改不刪由資料庫保證（回復時整張表連同 trigger 一起 DROP）
CREATE TRIGGER `stock_movements_no_update` BEFORE UPDATE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_delete` BEFORE DELETE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;--> statement-breakpoint
-- 保留式遷移（ADR 0006、設計 Q22）：舊系統在付款時就扣了在庫數，新模型付款只轉為保留、交運才扣。
-- 舊已付未出貨：在庫數加回，同時因為「已付款」狀態本身就是保留，所以可售量不變；舊已出貨不加回（已實際離倉）。
-- 先逐單逐變體寫流水（在庫數尚未更新，用視窗函式累加出每筆之後的在庫數），再一次更新在庫數。
-- 遷移只信訂單狀態，不臆造物流證據；狀態與付款紀錄對不上的例外由 scripts/verify-0020-stock.sql 核對。
INSERT INTO `stock_movements` (`variant_id`, `kind`, `delta`, `on_hand_after`, `order_id`, `actor`, `reason`, `created_at`)
SELECT line.`variant_id`, 'migration', line.`quantity`,
  variant.`on_hand` + SUM(line.`quantity`) OVER (PARTITION BY line.`variant_id` ORDER BY ord.`id`),
  ord.`id`, 'system:0020_stock_ledger', '遷移：舊已付未出貨加回在庫並建立已付款保留', CAST(strftime('%s', 'now') AS integer) * 1000
FROM `orders` ord
JOIN `order_lines` line ON line.`order_id` = ord.`id`
JOIN `product_variants` variant ON variant.`id` = line.`variant_id`
WHERE ord.`status` = 'paid';
--> statement-breakpoint
UPDATE `product_variants`
SET `on_hand` = `on_hand` + (
  SELECT SUM(line.`quantity`) FROM `order_lines` line JOIN `orders` ord ON ord.`id` = line.`order_id`
  WHERE ord.`status` = 'paid' AND line.`variant_id` = `product_variants`.`id`
)
WHERE `id` IN (SELECT line.`variant_id` FROM `order_lines` line JOIN `orders` ord ON ord.`id` = line.`order_id` WHERE ord.`status` = 'paid');
