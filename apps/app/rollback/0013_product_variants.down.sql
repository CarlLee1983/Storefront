-- 回復 0013_product_variants：把預設變體的售價、原價、在庫數寫回 products，訂單明細改回只指向商品。
-- 只在每個商品都恰好一個（預設）變體時可用；已有多變體的商品無法無損還原，守門檢查會讓整段失敗。
-- 用法：先停止寫入，再以 `wrangler d1 execute <DB> --file rollback/0013_product_variants.down.sql` 執行；
-- 最後一句移除遷移紀錄，之後可重新套用 0013。
DROP TABLE IF EXISTS `rollback_guard`;
--> statement-breakpoint
CREATE TABLE `rollback_guard` (`ok` integer NOT NULL CHECK(`ok` = 1));
--> statement-breakpoint
INSERT INTO `rollback_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `product_variants` WHERE `is_default` = 0)
  OR EXISTS (SELECT 1 FROM `products` p WHERE (SELECT count(*) FROM `product_variants` v WHERE v.`product_id` = p.`id`) <> 1)
  THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `rollback_guard`;
--> statement-breakpoint
ALTER TABLE `products` ADD `price_twd` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `products` ADD `compare_at_price_twd` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `on_hand` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `products` SET
  `price_twd` = (SELECT v.`price_twd` FROM `product_variants` v WHERE v.`product_id` = `products`.`id`),
  `compare_at_price_twd` = (SELECT v.`compare_at_price_twd` FROM `product_variants` v WHERE v.`product_id` = `products`.`id`),
  `on_hand` = (SELECT v.`on_hand` FROM `product_variants` v WHERE v.`product_id` = `products`.`id`);
--> statement-breakpoint
CREATE INDEX `products_compare_at_price_idx` ON `products` (`compare_at_price_twd`) WHERE compare_at_price_twd is not null;
--> statement-breakpoint
CREATE TABLE `order_lines_old` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_twd` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_lines_quantity_check" CHECK(`quantity` > 0)
);
--> statement-breakpoint
INSERT INTO `order_lines_old` (`id`, `order_id`, `product_id`, `product_name`, `quantity`, `unit_price_twd`)
SELECT `id`, `order_id`, `product_id`, `product_name`, `quantity`, `unit_price_twd` FROM `order_lines` ORDER BY `id`;
--> statement-breakpoint
DROP TABLE `order_lines`;
--> statement-breakpoint
ALTER TABLE `order_lines_old` RENAME TO `order_lines`;
--> statement-breakpoint
CREATE UNIQUE INDEX `order_lines_order_product_uidx` ON `order_lines` (`order_id`,`product_id`);
--> statement-breakpoint
CREATE INDEX `order_lines_product_idx` ON `order_lines` (`product_id`);
--> statement-breakpoint
DROP TABLE `product_variants`;
--> statement-breakpoint
DELETE FROM `d1_migrations` WHERE `name` = '0013_product_variants.sql';
