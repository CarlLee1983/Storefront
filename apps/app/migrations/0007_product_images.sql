CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` integer NOT NULL,
	`upload_id` text NOT NULL,
	`position` integer NOT NULL,
	`variants` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_images_position_check" CHECK("product_images"."position" >= 0 AND "product_images"."position" < 8)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_images_product_upload_uidx` ON `product_images` (`product_id`,`upload_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_images_product_position_uidx` ON `product_images` (`product_id`,`position`);--> statement-breakpoint
-- product_images is new, so all existing products have no images. Replace only
-- the listed column: rebuilding products would endanger order_lines foreign keys.
ALTER TABLE `products` DROP COLUMN `listed`;--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `listed` integer DEFAULT false NOT NULL;
