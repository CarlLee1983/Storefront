CREATE TABLE `payment_reconcile_issues` (
	`payment_id` integer PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`last_source` text NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_reconcile_issues_reason_check" CHECK("payment_reconcile_issues"."reason" IN ('gateway_unavailable', 'gateway_mismatch', 'result_unclear'))
);
