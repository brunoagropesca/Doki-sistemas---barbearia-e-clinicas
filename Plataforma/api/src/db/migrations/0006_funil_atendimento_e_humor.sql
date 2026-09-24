ALTER TABLE `appointments` ADD `anotacoes_atendimento` text;--> statement-breakpoint
ALTER TABLE `appointments` ADD `humor_atendimento` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `etapa_atendimento` text DEFAULT 'novo' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `humor` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `humor_resumo` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `humor_atualizado_em` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `humor_na_mensagem` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `anotacoes_humanas` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_conv_etapa` ON `conversations` (`tenant_id`,`etapa_atendimento`);