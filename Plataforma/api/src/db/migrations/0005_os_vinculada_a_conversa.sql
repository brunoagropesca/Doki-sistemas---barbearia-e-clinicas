ALTER TABLE `appointments` ADD `conversation_id` text REFERENCES conversations(id);--> statement-breakpoint
ALTER TABLE `appointments` ADD `resumo_atendimento` text;--> statement-breakpoint
ALTER TABLE `appointments` ADD `resumo_em` integer;--> statement-breakpoint
CREATE INDEX `idx_appt_conversa` ON `appointments` (`tenant_id`,`conversation_id`);