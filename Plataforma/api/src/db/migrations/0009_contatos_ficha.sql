ALTER TABLE `leads` ADD `endereco` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `foto_url` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `foto_sincronizada_em` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `ia_ativa` integer DEFAULT true NOT NULL;