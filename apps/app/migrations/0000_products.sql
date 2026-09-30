CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`price_twd` integer NOT NULL,
	`listed` integer DEFAULT true NOT NULL
);
