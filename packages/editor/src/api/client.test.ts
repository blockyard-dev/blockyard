/**
 * 匯入那條路上「後端還沒重啟」怎麼說（design.md §14.1）。
 *
 * 這個檔案存在的理由跟 `triggers.test.ts` 一樣，是一個真的踩到的東西：改完後端
 * 沒重啟，按下「從電腦(.zip)」得到的是一句 **`Method Not Allowed`**——而那句話
 * 不是我們的程式碼講的，是後端 `/` 底下那個 `StaticFiles` catch-all 講的（它只
 * 收 GET/HEAD）。畫在畫面上，它聽起來像「這個端點不收 POST」，實際的意思是
 * 「這個端點不存在」。
 *
 * 題目要釘住的是**那條界線**：404／405 換成自己的話，其他狀態碼**照舊用後端
 * 那一句**。後者才是這條規則會壞掉的方向——一個「都當成後端沒重啟」的版本會把
 * 「這個 .zip 裡沒有 manifest.yaml」蓋掉，而那正是使用者真正需要看到的字。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, inspectExtensionZip, installExtension } from './client';

function respond(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('匯入：後端還沒重啟', () => {
  it('405 換成一句說得出下一步的話', async () => {
    // 這就是那個 catch-all 的回應原文。
    respond(405, { detail: 'Method Not Allowed' });
    await expect(inspectExtensionZip(new Blob([]))).rejects.toThrow(/還沒重啟/);
  });

  it('404 是同一件事——路由不存在時，GET 與 POST 只是掉進去的方式不同', async () => {
    respond(404, { detail: 'Not Found' });
    await expect(inspectExtensionZip(new Blob([]))).rejects.toThrow(/還沒重啟/);
  });

  it('422 照舊用後端那一句', async () => {
    // 蓋掉它就是把使用者唯一能據以修正的字換成一個猜測。
    respond(422, { detail: { message: '這個 .zip 裡沒有 manifest.yaml' } });
    await expect(inspectExtensionZip(new Blob([]))).rejects.toThrow('這個 .zip 裡沒有 manifest.yaml');
  });

  it('狀態碼仍然帶著，換掉的只有那句話', async () => {
    respond(405, { detail: 'Method Not Allowed' });
    const error = await inspectExtensionZip(new Blob([])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(405);
  });

  it('**安裝那條路不認 404**——它在那裡有另一個合法的意思', async () => {
    // 「這份匯入已經過期或被取消了」是後端說得出來的準確答案。把它也換成
    // 「後端沒重啟」，就是拿一個猜測蓋掉一句真話。
    respond(404, { detail: { message: '這份匯入已經過期或被取消了，請重新選一次檔案' } });
    await expect(installExtension('t')).rejects.toThrow(/過期或被取消/);
  });
});
