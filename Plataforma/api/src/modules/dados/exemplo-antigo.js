import { and, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { leads } from '../../db/schema/crm.js';
import { conversations } from '../../db/schema/conversations.js';

/**
 * Os 3 clientes de exemplo que o seed ANTIGO criava em toda instalacao, com
 * celulares de SP validos (podem ser de alguem de verdade). A instalacao nova
 * nao cria mais (db/instalar.js), e o seed de exemplo usa numeros impossiveis.
 */
export const TELEFONES_DE_EXEMPLO_ANTIGOS = ['5511988776655', '5511977665544', '5511966554433'];

/**
 * Instalacao antiga que ainda tem esses clientes, sem nenhuma conversa com
 * eles (ou seja: nunca foram clientes de verdade). So AVISA o DEV — apagar e
 * decisao de quem conhece a loja: pode ser coincidencia de numero.
 */
export async function clientesDeExemploAntigos() {
  const achados = await db
    .select({ id: leads.id, tenantId: leads.tenantId, nome: leads.nome, telefone: leads.telefone })
    .from(leads)
    .where(and(inArray(leads.telefone, TELEFONES_DE_EXEMPLO_ANTIGOS), isNull(leads.deletedAt)));
  if (achados.length === 0) return [];

  const comConversa = new Set(
    (
      await db
        .select({ leadId: conversations.leadId })
        .from(conversations)
        .where(inArray(conversations.leadId, achados.map((l) => l.id)))
    ).map((c) => c.leadId)
  );
  return achados.filter((l) => !comConversa.has(l.id));
}
