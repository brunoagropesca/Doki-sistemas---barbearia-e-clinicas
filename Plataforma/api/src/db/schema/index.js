/**
 * Ponto unico de acesso ao schema.
 *
 * Todo o resto do sistema importa daqui (`import { leads } from '../db/schema/index.js'`),
 * nunca dos arquivos individuais. Isso deixa livre reorganizar a divisao interna
 * depois — juntar dois arquivos, quebrar um em tres — sem tocar em nenhum
 * modulo que consome o schema.
 */

export * from './tenants.js';
export * from './auth.js';
export * from './crm.js';
export * from './catalog.js';
export * from './scheduling.js';
export * from './conversations.js';
export * from './campaigns.js';
export * from './ai.js';
export * from './arquivos.js';
