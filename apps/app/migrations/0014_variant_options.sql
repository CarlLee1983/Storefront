ALTER TABLE `product_variants` ADD `option1_value` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `option2_value` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `discontinued_at` integer;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `image_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_options_uidx` ON `product_variants` (`product_id`,`option1_value`,`option2_value`);--> statement-breakpoint
ALTER TABLE `products` ADD `option1_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `option2_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_lines` ADD `variant_label` text DEFAULT '' NOT NULL;