CREATE TABLE `order_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`actor` text NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_notes_order_idx` ON `order_notes` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`,`id`);
--> statement-breakpoint
-- 客服備註只增不改不刪由資料庫保證（回復時整張表連同 trigger 一起 DROP）
CREATE TRIGGER `order_notes_no_update` BEFORE UPDATE ON `order_notes` BEGIN SELECT RAISE(ABORT, 'order_notes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `order_notes_no_delete` BEFORE DELETE ON `order_notes` BEGIN SELECT RAISE(ABORT, 'order_notes is append-only'); END;
