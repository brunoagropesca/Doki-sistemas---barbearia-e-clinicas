DROP TABLE `pipeline_stages`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`telefone` text NOT NULL,
	`nome` text NOT NULL,
	`email` text,
	`endereco` text DEFAULT '' NOT NULL,
	`foto_url` text,
	`foto_sincronizada_em` integer,
	`observacoes` text DEFAULT '' NOT NULL,
	`tags` text NOT NULL,
	`origem` text DEFAULT 'whatsapp' NOT NULL,
	`humor` text,
	`humor_atualizado_em` integer,
	`responsavel_id` text,
	`ultimo_contato_em` integer,
	`aceita_campanha` integer DEFAULT true NOT NULL,
	`ultima_campanha_em` integer,
	`ia_ativa` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`responsavel_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_leads`("id", "tenant_id", "telefone", "nome", "email", "endereco", "foto_url", "foto_sincronizada_em", "observacoes", "tags", "origem", "humor", "humor_atualizado_em", "responsavel_id", "ultimo_contato_em", "aceita_campanha", "ultima_campanha_em", "ia_ativa", "created_at", "updated_at", "deleted_at") SELECT "id", "tenant_id", "telefone", "nome", "email", "endereco", "foto_url", "foto_sincronizada_em", "observacoes", "tags", "origem", "humor", "humor_atualizado_em", "responsavel_id", "ultimo_contato_em", "aceita_campanha", "ultima_campanha_em", "ia_ativa", "created_at", "updated_at", "deleted_at" FROM `leads`;--> statement-breakpoint
DROP TABLE `leads`;--> statement-breakpoint
ALTER TABLE `__new_leads` RENAME TO `leads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_leads_tenant_telefone` ON `leads` (`tenant_id`,`telefone`);--> statement-breakpoint
CREATE INDEX `idx_leads_tenant_nome` ON `leads` (`tenant_id`,`nome`);--> statement-breakpoint
CREATE INDEX `idx_leads_responsavel` ON `leads` (`tenant_id`,`responsavel_id`);--> statement-breakpoint
CREATE INDEX `idx_leads_ultimo_contato` ON `leads` (`tenant_id`,`ultimo_contato_em`);