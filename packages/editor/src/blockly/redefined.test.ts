/**
 * 更新一個積木包之後，工具箱裡那顆積木的字要是新的（`extension-design.md` §4）。
 *
 * 這一題守的是一條**看不見的規則**：flyout 會把上一批積木依 `type` 收起來重用，
 * 而那假設同一個 `type` 永遠長同一個樣子。更新一個包打破了那個假設，而症狀
 * 看起來完全像另一件事——「重新註冊沒有生效」——所以那條規則要有一個測得到的
 * 名字（`wasRedefined`），而不是散在 flyout 的建構子裡。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetRedefined, markRedefined, wasRedefined } from './redefined';
import { registerManifests } from './setup';
import type { Manifest } from '../types/manifest';

describe('換過定義的 type', () => {
  beforeEach(() => forgetRedefined());

  it('沒被換過的 type 照樣可以回收——那是 flyout 的優化，不該整個關掉', () => {
    expect(wasRedefined('demo.echo')).toBe(false);
  });

  it('標記過就不回收', () => {
    markRedefined(['demo.echo', 'demo.wave']);
    expect(wasRedefined('demo.echo')).toBe(true);
    expect(wasRedefined('demo.wave')).toBe(true);
    expect(wasRedefined('http.get')).toBe(false);
  });

  it('**進來就不出去**：更新過兩次也還是不回收', () => {
    // 「換過的那一次不回收」要回答「什麼時候可以放回去」，而那個答案取決於
    // flyout 這一刻畫到哪裡——一個沒有人看得見、卻會偶爾錯一次的狀態。
    markRedefined(['demo.echo']);
    markRedefined(['demo.wave']);
    expect(wasRedefined('demo.echo')).toBe(true);
  });
});

describe('registerManifests 什麼時候留名', () => {
  beforeEach(() => forgetRedefined());

  const echo = (text: string): Manifest =>
    ({
      manifestVersion: 1,
      id: 'redef_demo',
      name: 'demo',
      version: '1.0.0',
      palette: [{ opcode: 'echo', type: 'reporter', text, returns: 'string' }],
    }) as Manifest;

  it('開場那一次不算——那時候還沒有任何東西畫出來過', () => {
    // 把 95 顆內建積木全部標成不回收，是為了一件沒有發生的事付一整場的代價。
    registerManifests([echo('說 %1')]);
    expect(wasRedefined('redef_demo.echo')).toBe(false);
  });

  it('宣告變了就留名——那是「同一個 type、換一份定義」', () => {
    const before = [echo('說 %1')];
    registerManifests(before);
    registerManifests([echo('大聲說 %1')], before);
    expect(wasRedefined('redef_demo.echo')).toBe(true);
  });

  it('沒變的那一個不留名', () => {
    const before = [echo('說 %1')];
    registerManifests(before);
    registerManifests([echo('說 %1')], before);
    expect(wasRedefined('redef_demo.echo')).toBe(false);
  });
});
