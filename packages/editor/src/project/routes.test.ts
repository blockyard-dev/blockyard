/**
 * 網址就是「你在哪一個地方」（`routes.ts`）。
 *
 * 這幾題釘的是**解析**那一半：導覽本身是 `location.assign`，那沒有東西可測。
 */
import { describe, expect, it } from 'vitest';
import { LIST_PATH, missingProjectPath, projectPath, routeOf } from './routes';

describe('routeOf', () => {
  it('`/p/<id>` 是編輯器，而 id 原樣拿回來', () => {
    expect(routeOf('/p/prj_ab12cd34')).toEqual({ name: 'editor', id: 'prj_ab12cd34' });
  });

  it('`/projects` 是主選單', () => {
    expect(routeOf(LIST_PATH)).toEqual({ name: 'list' });
  });

  it('`/docs/discord/` 是 Discord 教學', () => {
    expect(routeOf('/docs/discord/')).toEqual({ name: 'docs', page: 'discord' });
  });

  it('`/` 是首頁——它沒有內容，只是一個轉址', () => {
    expect(routeOf('/')).toEqual({ name: 'home' });
  });

  it('認不得的路徑當作首頁，不是一頁 404', () => {
    // 這個 app 只有兩個地方，而一個打錯的網址唯一合理的意思是「我想開這個
    // 工具」。一頁 404 在這裡只會是一個要使用者自己想辦法離開的死巷。
    expect(routeOf('/p')).toEqual({ name: 'home' });
    expect(routeOf('/p/')).toEqual({ name: 'home' });
    expect(routeOf('/nope/nope')).toEqual({ name: 'home' });
  });

  it('尾巴多一條斜線不算另一個地方', () => {
    expect(routeOf('/projects/')).toEqual({ name: 'list' });
    expect(routeOf('/p/prj_x/')).toEqual({ name: 'editor', id: 'prj_x' });
  });
});

describe('projectPath', () => {
  it('是 routeOf 的反函式——兩邊對不起來的話，切過去會落在首頁', () => {
    expect(routeOf(projectPath('prj_ab12cd34'))).toEqual({
      name: 'editor',
      id: 'prj_ab12cd34',
    });
  });

  it('id 進網址前先編碼。**它不該需要**（id 是 opaque 的十六進位字串），而那正是'
    + '為什麼這裡便宜——一個從別台機器帶回來的 bundle 可以帶著任何形狀的 id 回來', () => {
    expect(routeOf(projectPath('a/b'))).toEqual({ name: 'editor', id: 'a/b' });
  });
});

describe('那份專案不在了', () => {
  it('被踢回來的仍然是主選單——不是一頁 404，也不是一張新的白紙', () => {
    // **編輯器不准自己生一份出來。** 那是它原本做的事（P0b 的 id 是寫死的），
    // 而在多專案之後它的意思變成：打開一個死掉的網址 → 空白畫布 → 一存檔就
    // 把那份被刪掉的專案復活。
    expect(routeOf(missingProjectPath('prj_gone'))).toEqual({ name: 'list' });
  });

  it('帶著那個 id，所以那一頁說得出是哪一份不見了', () => {
    expect(missingProjectPath('prj_gone')).toBe(`${LIST_PATH}?gone=prj_gone`);
  });
});
