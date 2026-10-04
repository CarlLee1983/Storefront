CREATE TABLE `product_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`price_twd` integer NOT NULL,
	`compare_at_price_twd` integer,
	`on_hand` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_variants_product_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_default_uidx` ON `product_variants` (`product_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE INDEX `product_variants_compare_at_price_idx` ON `product_variants` (`compare_at_price_twd`) WHERE compare_at_price_twd is not null;--> statement-breakpoint
-- 每個既有商品轉成一個預設變體，售價、原價、在庫數原樣搬過去（待付款訂單的保留是訂單明細的加總，不另存，所以不受影響）
INSERT INTO `product_variants` (`product_id`, `is_default`, `price_twd`, `compare_at_price_twd`, `on_hand`)
SELECT `id`, 1, `price_twd`, `compare_at_price_twd`, `on_hand` FROM `products` ORDER BY `id`;--> statement-breakpoint
DROP INDEX `products_compare_at_price_idx`;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `price_twd`;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `compare_at_price_twd`;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `on_hand`;--> statement-breakpoint
-- 訂單明細改指向變體：新增 NOT NULL 欄位必須重建資料表（沒有別的資料表參照 order_lines）。
-- 以 LEFT JOIN 搬移：任何一筆明細對不到預設變體時 variant_id 為 NULL，違反 NOT NULL 讓整個遷移失敗，
-- 不會悄悄丟掉明細，也不會編造對應；單價、數量與名稱快照原樣保留，所以歷史實付金額不變。
CREATE TABLE `order_lines_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_twd` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_lines_quantity_check" CHECK(`quantity` > 0)
);
--> statement-breakpoint
INSERT INTO `order_lines_new` (`id`, `order_id`, `product_id`, `variant_id`, `product_name`, `quantity`, `unit_price_twd`)
SELECT l.`id`, l.`order_id`, l.`product_id`, v.`id`, l.`product_name`, l.`quantity`, l.`unit_price_twd`
FROM `order_lines` l
LEFT JOIN `product_variants` v ON v.`product_id` = l.`product_id` AND v.`is_default` = 1
ORDER BY l.`id`;--> statement-breakpoint
DROP TABLE `order_lines`;--> statement-breakpoint
ALTER TABLE `order_lines_new` RENAME TO `order_lines`;--> statement-breakpoint
CREATE UNIQUE INDEX `order_lines_order_variant_uidx` ON `order_lines` (`order_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `order_lines_variant_idx` ON `order_lines` (`variant_id`);
