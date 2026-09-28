CREATE TABLE `ai_calls_mensais` (
	`tenant_id` text NOT NULL,
	`mes` text NOT NULL,
	`origem` text NOT NULL,
	`agent_key` text DEFAULT '' NOT NULL,
	`provedor` text NOT NULL,
	`modelo` text NOT NULL,
	`chamadas` integer DEFAULT 0 NOT NULL,
	`sucessos` integer DEFAULT 0 NOT NULL,
	`tokens_entrada` integer DEFAULT 0 NOT NULL,
	`tokens_saida` integer DEFAULT 0 NOT NULL,
	`latencia_soma_sucesso_ms` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_aicalls_mensais` ON `ai_calls_mensais` (`tenant_id`,`mes`,`origem`,`agent_key`,`provedor`,`modelo`);