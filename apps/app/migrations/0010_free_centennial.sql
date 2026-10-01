CREATE TABLE `category_images` (
	`category_id` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`upload_id` text NOT NULL,
	`variants` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
