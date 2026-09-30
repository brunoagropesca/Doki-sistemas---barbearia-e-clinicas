import { and, eq } from 'drizzle-orm';
import * as s from '../../db/schema/index.js';
import { cifrarCom, decifrarCom } from '../../core/crypto.js';

/**
 * Recifra, de um APP_SECRET para outro, tudo que o banco guarda cifrado.
 *
 * Hoje sao dois lugares — e SO eles chamam `cifrar()` no sistema:
 *   - a chave de cada provedor de IA (`ai_providers.api_key_cifrada`);
 *   - a chave do Hades (`settings`, chave `hades.config`, campo `chaveCifrada`).
 * Quem passar a cifrar algo novo precisa acrescentar aqui: o teste
 * `trocar-segredo.test.js` falha se aparecer `cifrar(` num arquivo novo.
 *
 * Tudo numa transacao: ou todas as chaves passam para o segredo novo, ou
 * nenhuma — metade num segredo e metade no outro seria perder metade.
 *
 * Pode rodar de novo sem estragar nada: valor que JA abre com o segredo novo
 * (troca interrompida no meio e retomada) fica como esta (`jaNoNovo`).
 *
 * Valor que nao abre com nenhum dos dois (corrompido, ou cifrado com um
 * terceiro segredo) fica como esta e e contado em `ilegiveis`: ele ja nao
 * funcionava antes, e apagar seria destruir a unica copia.
 *
 * @param {import('drizzle-orm/libsql').LibSQLDatabase} db
 * @param {{ de: string, para: string }} segredos
 */
export async function recifrarSegredos(db, { de, para }) {
  const resultado = { recifradas: 0, jaNoNovo: 0, ilegiveis: 0 };

  const trocar = (valor) => {
    const puro = decifrarCom(valor, de);
    if (puro != null) {
      resultado.recifradas++;
      return cifrarCom(puro, para);
    }
    if (decifrarCom(valor, para) != null) resultado.jaNoNovo++;
    else resultado.ilegiveis++;
    return null;
  };

  await db.transaction(async (tx) => {
    const provedores = await tx
      .select({ id: s.aiProviders.id, chave: s.aiProviders.apiKeyCifrada })
      .from(s.aiProviders);
    for (const p of provedores) {
      if (!p.chave) continue;
      const nova = trocar(p.chave);
      if (nova) await tx.update(s.aiProviders).set({ apiKeyCifrada: nova }).where(eq(s.aiProviders.id, p.id));
    }

    const hades = await tx.select().from(s.settings).where(eq(s.settings.chave, 'hades.config'));
    for (const h of hades) {
      if (!h.valor?.chaveCifrada) continue;
      const nova = trocar(h.valor.chaveCifrada);
      if (nova) {
        await tx
          .update(s.settings)
          .set({ valor: { ...h.valor, chaveCifrada: nova } })
          .where(and(eq(s.settings.tenantId, h.tenantId), eq(s.settings.chave, h.chave)));
      }
    }
  });

  return resultado;
}
