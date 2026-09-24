CREATE TABLE `service_history` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`appointment_id` text,
	`resultado` text NOT NULL,
	`professional_id` text,
	`professional_nome` text NOT NULL,
	`service_id` text,
	`service_nome` text NOT NULL,
	`service_categoria` text DEFAULT 'Geral' NOT NULL,
	`lead_id` text,
	`cliente_novo` integer DEFAULT false NOT NULL,
	`preco_centavos` integer DEFAULT 0 NOT NULL,
	`desconto_centavos` integer DEFAULT 0 NOT NULL,
	`valor_centavos` integer DEFAULT 0 NOT NULL,
	`preco_tabela_centavos` integer DEFAULT 0 NOT NULL,
	`duracao_minutos` integer DEFAULT 0 NOT NULL,
	`inicio_em` integer NOT NULL,
	`encerrado_em` integer NOT NULL,
	`data_local` text NOT NULL,
	`dia_semana` integer NOT NULL,
	`hora_local` integer NOT NULL,
	`antecedencia_horas` integer,
	`origem` text NOT NULL,
	`responsavel_user_id` text,
	`conversation_id` text,
	`humor` text,
	`motivo_cancelamento` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`responsavel_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_history_appointment` ON `service_history` (`appointment_id`);--> statement-breakpoint
CREATE INDEX `idx_history_prof_data` ON `service_history` (`tenant_id`,`professional_id`,`data_local`);--> statement-breakpoint
CREATE INDEX `idx_history_tenant_data` ON `service_history` (`tenant_id`,`data_local`);--> statement-breakpoint
CREATE INDEX `idx_history_lead` ON `service_history` (`tenant_id`,`lead_id`);