CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`nome` text NOT NULL,
	`slug` text NOT NULL,
	`segmento` text DEFAULT 'outro' NOT NULL,
	`fuso_horario` text DEFAULT 'America/Sao_Paulo' NOT NULL,
	`email_contato` text,
	`telefone_contato` text,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tenants_slug` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`user_nome` text,
	`acao` text NOT NULL,
	`entidade` text NOT NULL,
	`entidade_id` text,
	`dados` text NOT NULL,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_audit_tenant_data` ON `audit_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_entidade` ON `audit_logs` (`tenant_id`,`entidade`,`entidade_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expira_em` integer NOT NULL,
	`revogada_em` integer,
	`ultimo_uso_em` integer,
	`user_agent` text,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_token` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expira` ON `sessions` (`expira_em`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`username` text NOT NULL,
	`nome` text NOT NULL,
	`email` text,
	`telefone` text,
	`password_hash` text NOT NULL,
	`cargo` text DEFAULT 'atendente' NOT NULL,
	`status_presenca` text DEFAULT 'offline' NOT NULL,
	`capacidade_simultanea` integer DEFAULT 5 NOT NULL,
	`avatar` text,
	`ativo` integer DEFAULT true NOT NULL,
	`ultimo_login_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_tenant_username` ON `users` (`tenant_id`,`username`);--> statement-breakpoint
CREATE INDEX `idx_users_tenant_cargo` ON `users` (`tenant_id`,`cargo`);--> statement-breakpoint
CREATE INDEX `idx_users_presenca` ON `users` (`tenant_id`,`status_presenca`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`telefone` text NOT NULL,
	`nome` text NOT NULL,
	`email` text,
	`stage_id` text,
	`observacoes` text DEFAULT '' NOT NULL,
	`tags` text NOT NULL,
	`origem` text DEFAULT 'whatsapp' NOT NULL,
	`humor` text,
	`humor_atualizado_em` integer,
	`responsavel_id` text,
	`ultimo_contato_em` integer,
	`aceita_campanha` integer DEFAULT true NOT NULL,
	`ultima_campanha_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `pipeline_stages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`responsavel_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_leads_tenant_telefone` ON `leads` (`tenant_id`,`telefone`);--> statement-breakpoint
CREATE INDEX `idx_leads_tenant_stage` ON `leads` (`tenant_id`,`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_leads_tenant_nome` ON `leads` (`tenant_id`,`nome`);--> statement-breakpoint
CREATE INDEX `idx_leads_responsavel` ON `leads` (`tenant_id`,`responsavel_id`);--> statement-breakpoint
CREATE INDEX `idx_leads_ultimo_contato` ON `leads` (`tenant_id`,`ultimo_contato_em`);--> statement-breakpoint
CREATE TABLE `pipeline_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`chave` text NOT NULL,
	`nome` text NOT NULL,
	`cor` text DEFAULT '#64748b' NOT NULL,
	`ordem` integer DEFAULT 0 NOT NULL,
	`eh_inicial` integer DEFAULT false NOT NULL,
	`eh_final` integer DEFAULT false NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stages_tenant_chave` ON `pipeline_stages` (`tenant_id`,`chave`);--> statement-breakpoint
CREATE INDEX `idx_stages_tenant_ordem` ON `pipeline_stages` (`tenant_id`,`ordem`);--> statement-breakpoint
CREATE TABLE `professionals` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`nome` text NOT NULL,
	`funcao` text DEFAULT 'Especialista' NOT NULL,
	`cor` text DEFAULT '#3b82f6' NOT NULL,
	`user_id` text,
	`jornada` text NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_professionals_tenant` ON `professionals` (`tenant_id`,`ativo`);--> statement-breakpoint
CREATE TABLE `schedule_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`professional_id` text,
	`motivo` text DEFAULT 'Indisponivel' NOT NULL,
	`inicio_em` integer NOT NULL,
	`fim_em` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_blocks_tenant_periodo` ON `schedule_blocks` (`tenant_id`,`inicio_em`,`fim_em`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`nome` text NOT NULL,
	`descricao` text DEFAULT '' NOT NULL,
	`categoria` text DEFAULT 'Geral' NOT NULL,
	`sku` text,
	`preco_centavos` integer DEFAULT 0 NOT NULL,
	`custo_centavos` integer DEFAULT 0 NOT NULL,
	`estoque` integer DEFAULT 0 NOT NULL,
	`estoque_minimo` integer DEFAULT 0 NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_products_tenant_ativo` ON `products` (`tenant_id`,`ativo`);--> statement-breakpoint
CREATE INDEX `idx_products_tenant_sku` ON `products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE TABLE `professional_services` (
	`tenant_id` text NOT NULL,
	`professional_id` text NOT NULL,
	`service_id` text NOT NULL,
	`preco_centavos` integer,
	`duracao_minutos` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`professional_id`, `service_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_prof_services_tenant` ON `professional_services` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_prof_services_service` ON `professional_services` (`service_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`nome` text NOT NULL,
	`descricao` text DEFAULT '' NOT NULL,
	`categoria` text DEFAULT 'Geral' NOT NULL,
	`duracao_minutos` integer DEFAULT 30 NOT NULL,
	`preco_centavos` integer DEFAULT 0 NOT NULL,
	`intervalo_apos_minutos` integer DEFAULT 0 NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_services_tenant_ativo` ON `services` (`tenant_id`,`ativo`);--> statement-breakpoint
CREATE INDEX `idx_services_tenant_categoria` ON `services` (`tenant_id`,`categoria`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`tipo` text NOT NULL,
	`quantidade` integer NOT NULL,
	`estoque_resultante` integer NOT NULL,
	`motivo` text DEFAULT '' NOT NULL,
	`referencia_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_stock_tenant_produto` ON `stock_movements` (`tenant_id`,`product_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`service_id` text NOT NULL,
	`professional_id` text NOT NULL,
	`inicio_em` integer NOT NULL,
	`fim_em` integer NOT NULL,
	`status` text DEFAULT 'pendente' NOT NULL,
	`preco_centavos` integer DEFAULT 0 NOT NULL,
	`desconto_centavos` integer DEFAULT 0 NOT NULL,
	`observacoes` text DEFAULT '' NOT NULL,
	`checklist` text NOT NULL,
	`criado_por` text DEFAULT 'humano' NOT NULL,
	`criado_por_user_id` text,
	`confirmado_em` integer,
	`concluido_em` integer,
	`cancelado_em` integer,
	`motivo_cancelamento` text,
	`arquivado_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`criado_por_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_appt_tenant_prof_inicio` ON `appointments` (`tenant_id`,`professional_id`,`inicio_em`);--> statement-breakpoint
CREATE INDEX `idx_appt_tenant_inicio` ON `appointments` (`tenant_id`,`inicio_em`);--> statement-breakpoint
CREATE INDEX `idx_appt_tenant_status` ON `appointments` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_appt_lead` ON `appointments` (`tenant_id`,`lead_id`);--> statement-breakpoint
CREATE TABLE `product_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text,
	`product_id` text NOT NULL,
	`appointment_id` text,
	`quantidade` integer DEFAULT 1 NOT NULL,
	`preco_unitario_centavos` integer DEFAULT 0 NOT NULL,
	`total_centavos` integer DEFAULT 0 NOT NULL,
	`vendido_por_user_id` text,
	`vendido_em` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`vendido_por_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sales_tenant_data` ON `product_sales` (`tenant_id`,`vendido_em`);--> statement-breakpoint
CREATE INDEX `idx_sales_lead` ON `product_sales` (`tenant_id`,`lead_id`);--> statement-breakpoint
CREATE TABLE `channel_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`canal` text NOT NULL,
	`chave` text NOT NULL,
	`nome` text NOT NULL,
	`status` text DEFAULT 'desconectado' NOT NULL,
	`identificador` text,
	`nome_perfil` text,
	`qr_code` text,
	`qr_expira_em` integer,
	`config` text NOT NULL,
	`ia_habilitada` integer DEFAULT true NOT NULL,
	`ultimo_erro` text,
	`conectado_em` integer,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_channels_tenant_chave` ON `channel_instances` (`tenant_id`,`chave`);--> statement-breakpoint
CREATE INDEX `idx_channels_tenant_canal` ON `channel_instances` (`tenant_id`,`canal`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`channel_instance_id` text,
	`canal` text DEFAULT 'whatsapp' NOT NULL,
	`status` text DEFAULT 'bot' NOT NULL,
	`assigned_user_id` text,
	`assumida_em` integer,
	`ultima_mensagem_preview` text DEFAULT '' NOT NULL,
	`ultima_mensagem_em` integer,
	`nao_lidas` integer DEFAULT 0 NOT NULL,
	`primeira_resposta_segundos` integer,
	`total_mensagens_cliente` integer DEFAULT 0 NOT NULL,
	`total_mensagens_ia` integer DEFAULT 0 NOT NULL,
	`total_mensagens_humano` integer DEFAULT 0 NOT NULL,
	`historico_transferencias` text NOT NULL,
	`resumo` text,
	`finalizada_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_instance_id`) REFERENCES `channel_instances`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_conv_tenant_status` ON `conversations` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_conv_tenant_ultima_msg` ON `conversations` (`tenant_id`,`ultima_mensagem_em`);--> statement-breakpoint
CREATE INDEX `idx_conv_lead` ON `conversations` (`tenant_id`,`lead_id`);--> statement-breakpoint
CREATE INDEX `idx_conv_atendente` ON `conversations` (`tenant_id`,`assigned_user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`direcao` text NOT NULL,
	`autor_tipo` text NOT NULL,
	`autor_user_id` text,
	`tipo` text DEFAULT 'texto' NOT NULL,
	`conteudo` text NOT NULL,
	`midia_url` text,
	`transcricao` text,
	`external_id` text,
	`metadados` text NOT NULL,
	`erro_envio` text,
	`entregue_em` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`autor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_msg_conversa_data` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_msg_tenant_data` ON `messages` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_msg_external` ON `messages` (`tenant_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `campaign_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`telefone` text NOT NULL,
	`nome_cliente` text NOT NULL,
	`mensagem` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pendente' NOT NULL,
	`enviado_em` integer,
	`erro` text,
	`tentativas` integer DEFAULT 0 NOT NULL,
	`resposta_texto` text,
	`respondido_em` integer,
	`classificacao` text,
	`contexto_geracao` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_targets_campanha_lead` ON `campaign_targets` (`campaign_id`,`lead_id`);--> statement-breakpoint
CREATE INDEX `idx_targets_campanha_status` ON `campaign_targets` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_targets_tenant` ON `campaign_targets` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`nome` text NOT NULL,
	`objetivo` text DEFAULT '' NOT NULL,
	`modo` text DEFAULT 'ia_personalizada' NOT NULL,
	`template` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'rascunho' NOT NULL,
	`channel_instance_id` text NOT NULL,
	`intervalo_min_segundos` integer DEFAULT 25 NOT NULL,
	`intervalo_max_segundos` integer DEFAULT 70 NOT NULL,
	`limite_diario` integer DEFAULT 150 NOT NULL,
	`janela_inicio` text DEFAULT '09:00' NOT NULL,
	`janela_fim` text DEFAULT '20:00' NOT NULL,
	`total_alvos` integer DEFAULT 0 NOT NULL,
	`total_enviadas` integer DEFAULT 0 NOT NULL,
	`total_falhas` integer DEFAULT 0 NOT NULL,
	`total_respostas` integer DEFAULT 0 NOT NULL,
	`criado_por_user_id` text,
	`iniciada_em` integer,
	`concluida_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_instance_id`) REFERENCES `channel_instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`criado_por_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_campaigns_tenant_status` ON `campaigns` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`chave` text NOT NULL,
	`nome` text NOT NULL,
	`avatar` text,
	`system_prompt` text DEFAULT '' NOT NULL,
	`tom` text DEFAULT 'acolhedor' NOT NULL,
	`temperatura_milesimos` integer DEFAULT 700 NOT NULL,
	`modelo_preferido` text,
	`max_tokens` integer DEFAULT 800 NOT NULL,
	`ferramentas` text NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agents_tenant_chave` ON `agent_profiles` (`tenant_id`,`chave`);--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`origem` text NOT NULL,
	`agent_key` text,
	`provedor` text NOT NULL,
	`modelo` text NOT NULL,
	`sucesso` integer NOT NULL,
	`latencia_ms` integer DEFAULT 0 NOT NULL,
	`tokens_entrada` integer DEFAULT 0 NOT NULL,
	`tokens_saida` integer DEFAULT 0 NOT NULL,
	`tentativas` text NOT NULL,
	`erro` text,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_aicalls_tenant_data` ON `ai_calls` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_aicalls_tenant_origem` ON `ai_calls` (`tenant_id`,`origem`);--> statement-breakpoint
CREATE TABLE `ai_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provedor` text NOT NULL,
	`api_key_cifrada` text,
	`api_key_sufixo` text,
	`base_url` text,
	`modelo_padrao` text,
	`habilitado` integer DEFAULT false NOT NULL,
	`prioridade` integer DEFAULT 100 NOT NULL,
	`modelos` text NOT NULL,
	`testado_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_tenant_provedor` ON `ai_providers` (`tenant_id`,`provedor`);--> statement-breakpoint
CREATE INDEX `idx_ai_tenant_prioridade` ON `ai_providers` (`tenant_id`,`prioridade`);--> statement-breakpoint
CREATE TABLE `menu_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`nome` text DEFAULT 'Menu principal' NOT NULL,
	`mensagem_boas_vindas` text DEFAULT '' NOT NULL,
	`mensagem_erro` text DEFAULT '' NOT NULL,
	`opcoes` text NOT NULL,
	`ativo` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_menus_tenant_ativo` ON `menu_flows` (`tenant_id`,`ativo`);--> statement-breakpoint
CREATE TABLE `settings` (
	`tenant_id` text NOT NULL,
	`chave` text NOT NULL,
	`valor` text NOT NULL,
	`descricao` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_settings_tenant_chave` ON `settings` (`tenant_id`,`chave`);