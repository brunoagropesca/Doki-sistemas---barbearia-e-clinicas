import { aplicarRestauracaoPendente } from './restauracao.js';

/**
 * Importado em PRIMEIRO lugar por `main.js`: aplica uma restauracao de backup
 * agendada enquanto o arquivo do banco ainda esta fechado.
 */
aplicarRestauracaoPendente();
