CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_uidx` ON `categories` (`slug`);--> statement-breakpoint
ALTER TABLE `products` ADD `category_id` integer REFERENCES categories(id);--> statement-breakpoint
ALTER TABLE `products` ADD `listed_at` integer;--> statement-breakpoint
CREATE INDEX `products_category_listed_idx` ON `products` (`category_id`,`listed`);--> statement-breakpoint
-- 上架必須有分類：category_id 是新欄位，現有的上架商品都還沒有分類，先全部下架（管理員之後歸類再重新上架）。
UPDATE `products` SET `listed` = 0 WHERE `listed` = 1 AND `category_id` IS NULL;
