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
--> statement-breakpoint
-- INSERT OR REPLACE 不會觸發 DELETE trigger，會悄悄覆蓋既有編號的列：兩張只增表都擋下指定既有編號的插入
CREATE TRIGGER `order_notes_no_replace` BEFORE INSERT ON `order_notes` WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM `order_notes` WHERE `id` = NEW.`id`) BEGIN SELECT RAISE(ABORT, 'order_notes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_replace` BEFORE INSERT ON `stock_movements` WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM `stock_movements` WHERE `id` = NEW.`id`) BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
