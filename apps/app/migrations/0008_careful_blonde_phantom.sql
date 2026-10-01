CREATE TABLE `product_image_deletions` (
	`attempted_at` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`product_id` integer NOT NULL,
	`variants` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `product_images_product_position_uidx`;--> statement-breakpoint
CREATE INDEX `product_images_product_position_idx` ON `product_images` (`product_id`,`position`);