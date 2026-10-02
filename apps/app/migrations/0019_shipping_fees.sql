CREATE TABLE `shipping_rates` (
	`delivery_type` text PRIMARY KEY NOT NULL,
	`fee_twd` integer NOT NULL,
	CONSTRAINT "shipping_rates_type_check" CHECK("shipping_rates"."delivery_type" IN ('standard', 'large')),
	CONSTRAINT "shipping_rates_fee_check" CHECK("shipping_rates"."fee_twd" >= 0)
);
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `delivery_type` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_lines` ADD `delivery_type` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `standard_shipping_fee_twd` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `large_shipping_fee_twd` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 初始演練費率：一般宅配 NT$100、大型配送 NT$600；既有訂單的運費欄位維持預設 0（當時免運），金額不變
INSERT INTO `shipping_rates` (`delivery_type`, `fee_twd`) VALUES ('standard', 100), ('large', 600);
