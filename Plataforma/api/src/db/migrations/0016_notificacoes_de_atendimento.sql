CREATE TABLE `team_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`lead_nome` text,
	`motivo` text DEFAULT '' NOT NULL,
	`urgente` integer DEFAULT false NOT NULL,
	`fechada_em` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_team_notifications_abertas` ON `team_notifications` (`tenant_id`,`user_id`,`fechada_em`);--> statement-breakpoint
CREATE INDEX `idx_team_notifications_conversa` ON `team_notifications` (`tenant_id`,`conversation_id`);