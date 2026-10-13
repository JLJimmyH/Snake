// Google 檔案選擇器（Picker）：drive.file 權限只看得到這個 app 建立的檔案，別人共用過來的頁面，
// 要使用者在選擇器裡選一次，app 才能開啟它（之後就一直可以）。需要 Picker API 金鑰，見 docs/GOOGLE_DRIVE_SETUP.md。
import { GOOGLE_PICKER_KEY, GOOGLE_APP_ID } from './drive-config.js';

let loading;
function load() {
  if (globalThis.google?.picker) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js'; script.async = true;
    script.onload = () => gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('無法載入 Google 檔案選擇器')) });
    script.onerror = () => { loading = null; script.remove(); reject(new Error('無法載入 Google 檔案選擇器')); };
    document.head.append(script);
  });
  return loading;
}

export const pickerReady = () => !!GOOGLE_PICKER_KEY;

// 讓使用者選共用頁。fileId：只顯示這個檔案（從共用連結開啟時）；回傳選到的 { id, name }，取消回傳 null
export async function pickPage(token, fileId = null) {
  if (!GOOGLE_PICKER_KEY) throw new Error('網站尚未設定 Google 檔案選擇器金鑰');
  await load();
  const { picker } = google;
  const view = new picker.DocsView(picker.ViewId.DOCS).setMimeTypes('application/zip').setIncludeFolders(false).setMode(picker.DocsViewMode.LIST);
  if (fileId && view.setFileIds) view.setFileIds(fileId);
  else view.setOwnedByMe(false);
  return new Promise(resolve => {
    new picker.PickerBuilder()
      .setTitle(fileId ? '選取這個共用頁面，允許 Snake Note 開啟' : '選取別人共用給你的頁面')
      .setAppId(GOOGLE_APP_ID).setOAuthToken(token).setDeveloperKey(GOOGLE_PICKER_KEY)
      .addView(view).setLocale('zh-TW')
      .setCallback(data => {
        if (data.action === picker.Action.PICKED) resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build().setVisible(true);
  });
}
