ALTER TABLE `orders` ADD `paid_by_payment_id` integer;--> statement-breakpoint
ALTER TABLE `payments` ADD `refund_reason` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `refund_at` integer;--> statement-breakpoint
-- 既有的已付款／已出貨訂單：以它唯一成功的付款當作支付者（本 migration 之前只有待付款能轉已付款，所以最多一筆成功）
UPDATE `orders` SET `paid_by_payment_id` = (SELECT MIN(`id`) FROM `payments` WHERE `payments`.`order_id` = `orders`.`id` AND `payments`.`status` = 'succeeded') WHERE `status` IN ('paid', 'shipped');
