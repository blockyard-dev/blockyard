/**
 * 「哪幾個積木包在工具箱上」那份名單（D31）。
 *
 * `localStorage` 在測試環境裡不存在，而 `prefs.ts` 讀寫都吞例外——所以這份測試
 * 驗的是名單的**規則**，不是它存到哪裡去了。存哪裡是 §16 Q15 還沒定案的事。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeEnabled, useExtensionsUi } from './extensionsStore';

describe('偏好 ∪ 專案用到的（`mergeEnabled`）', () => {
  it('兩邊都留著', () => {
    expect([...mergeEnabled(['http'], ['discord'])]).toEqual(['http', 'discord']);
  });

  it('重複的只算一個', () => {
    expect([...mergeEnabled(['http'], ['http'])]).toEqual(['http']);
  });

  it('專案用到的一定在——不然打開別人的專案會看到積木、而工具箱裡生不出它', () => {
    expect(mergeEnabled([], ['openai']).has('openai')).toBe(true);
  });

  it('偏好裡的不會因為這個專案沒用到就消失——「我明明加過了」最難查', () => {
    expect(mergeEnabled(['openai'], []).has('openai')).toBe(true);
  });
});

describe('store 的加與移除', () => {
  beforeEach(() => useExtensionsUi.setState({ enabled: new Set(), open: false }));

  it('加進來、再移除', () => {
    const { add, remove } = useExtensionsUi.getState();
    add('http');
    expect(useExtensionsUi.getState().enabled.has('http')).toBe(true);
    remove('http');
    expect(useExtensionsUi.getState().enabled.has('http')).toBe(false);
  });

  it('內容沒變就不換那個 Set——換了的話 App 會重建一份長得一樣的工具箱，而重建會把 flyout 捲回頂端', () => {
    const { add, remove, initEnabled } = useExtensionsUi.getState();
    add('http');
    const before = useExtensionsUi.getState().enabled;

    add('http');
    expect(useExtensionsUi.getState().enabled).toBe(before);
    remove('openai');
    expect(useExtensionsUi.getState().enabled).toBe(before);
    initEnabled(['http']);
    expect(useExtensionsUi.getState().enabled).toBe(before);

    initEnabled(['discord']);
    expect(useExtensionsUi.getState().enabled).not.toBe(before);
    expect([...useExtensionsUi.getState().enabled]).toEqual(['http', 'discord']);
  });
});
