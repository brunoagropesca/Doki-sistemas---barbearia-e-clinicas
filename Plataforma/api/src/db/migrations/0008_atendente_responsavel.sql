ALTER TABLE `appointments` ADD `responsavel_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_appt_responsavel` ON `appointments` (`tenant_id`,`responsavel_user_id`,`inicio_em`);--> statement-breakpoint
-- Horarios que ja existem: o responsavel e quem conduzia a conversa; sem conversa, quem marcou.
UPDATE `appointments` SET `responsavel_user_id` = COALESCE(
  (SELECT `assigned_user_id` FROM `conversations` WHERE `conversations`.`id` = `appointments`.`conversation_id`),
  `criado_por_user_id`
) WHERE `responsavel_user_id` IS NULL;
