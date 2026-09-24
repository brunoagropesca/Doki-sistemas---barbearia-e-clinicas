ALTER TABLE `campaign_targets` ADD `mensagem_reserva` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_targets_lead` ON `campaign_targets` (`tenant_id`,`lead_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `ia_config` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `simular_digitacao` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `espera_motivo` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `retoma_em` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `proximo_envio_em` integer;