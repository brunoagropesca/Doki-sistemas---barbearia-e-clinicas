ALTER TABLE `conversations` ADD `menu_estado` text;--> statement-breakpoint
ALTER TABLE `menu_flows` ADD `fluxo` text DEFAULT '{}' NOT NULL;
