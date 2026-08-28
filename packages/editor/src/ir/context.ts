/**
 * IR ↔ Blockly 轉換層共用的查表（§8.4）。
 *
 * `serialize.ts` / `deserialize.ts` 都需要「給一個 Blockly type，查回它的
 * manifest 宣告（`args`、影子）」——不管那顆積木是普通命名空間的還是
 * `procedures.ts` 動態產生的。併成一份 `Map` 之後，兩邊都不必分辨積木的
 * 出身，這正是 `procedures.ts` 回傳同一種 `RegisteredBlock` 形狀的理由。
 */
import type { RegisteredBlock } from '../blockly/define';

export interface ConversionContext {
  blockOf(type: string): RegisteredBlock | undefined;
}

export function buildContext(blocks: RegisteredBlock[]): ConversionContext {
  const byType = new Map(blocks.map((b) => [b.type, b]));
  return { blockOf: (type) => byType.get(type) };
}
